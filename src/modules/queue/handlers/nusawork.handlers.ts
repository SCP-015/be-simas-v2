// Nusawork job handlers — only imported by the queue worker, not the API server.
import { queueService } from "../queue.module"
import { assetHolderService } from "../../asset-holder/asset-holder.module"
import { nusaworkHelper } from "../../../core/helpers/nusawork"
import { NotFoundException } from "../../../core/exceptions/base"
import { logger } from "../../../core/helpers/logger"
import type { AssetHolder } from "../../asset-holder/entities/asset-holder.entity"

/** Nusawork expects date fields as a full "YYYY-MM-DD HH:mm:ss" datetime, not a bare date. */
function formatNusaworkDateTime(input: string): string {
    const dateOnlyMatch = input.match(/^(\d{4}-\d{2}-\d{2})$/)
    if (dateOnlyMatch) {
        return `${dateOnlyMatch[1]} 00:00:00`
    }
    const date = new Date(input)
    const pad = (n: number) => String(n).padStart(2, "0")
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * Resolves the Nusawork `id_group` for a holder:
 * 1. Fast path: if already saved in `log.nusaworkGroupId`, return it directly (0 API calls).
 * 2. Fallback path (legacy notes or unmigrated rows): fetch Nusawork note groups and match:
 *    a) by item `key === "id_holder"` matching `log.id`
 *    b) fallback: by item `key === "asset_code"` matching `log.asset.code`
 * 3. Persist the found `id_group` to `asset_holders.nusawork_group_id` for future operations.
 */
async function resolveNusaworkGroupId(log: AssetHolder): Promise<number> {
    if (log.nusaworkGroupId) {
        return log.nusaworkGroupId
    }

    const employeeExternalId = log.employee?.employeeId
    if (!employeeExternalId) {
        throw new Error(`Cannot resolve Nusawork group ID: Holder ${log.id} has no employeeExternalId`)
    }

    const groups = await nusaworkHelper.getAssetSyncGroups(employeeExternalId)

    // 1. Match by id_holder
    let group = groups.find((g) => g.items?.some((item) => item.key === "id_holder" && item.input?.value === String(log.id)))

    // 2. Fallback: match by asset_code if id_holder is missing or removed in Nusawork
    if (!group && log.asset?.code) {
        group = groups.find((g) => g.items?.some((item) => item.key === "asset_code" && item.input?.value === log.asset?.code))
    }

    if (!group) {
        const seenHolderIds = groups.flatMap((g) => g.items?.filter((item) => item.key === "id_holder").map((item) => item.input?.value) ?? [])
        throw new Error(`Could not find Nusawork note group for holder ${log.id} (employee ${employeeExternalId}). Seen id_holder values: [${seenHolderIds.join(", ")}]`)
    }

    // Persist to DB so subsequent returns/updates don't need to query Nusawork note groups again.
    try {
        await assetHolderService.updateNusaworkGroupId(log.id, group.id_group)
    } catch (err: any) {
        logger.warn(`[nusawork.handlers] Failed to cache nusaworkGroupId for holder ${log.id}: ${err?.message || err}`)
    }

    return group.id_group
}

/** Returns null (not a thrown error) if the holder was deleted before the job ran. */
async function loadHolderOrSkip(holderId: number, jobType: string): Promise<AssetHolder | null> {
    try {
        const { log } = await assetHolderService.getById(holderId)
        return log
    } catch (err) {
        if (err instanceof NotFoundException) {
            logger.info(`[nusawork.handlers] Skipping ${jobType} for holder ${holderId}: record no longer exists`)
            return null
        }
        throw err
    }
}

queueService.registerHandler("nusawork.assign", async (payload) => {
    const { holderId } = payload as { holderId: number }
    const log = await loadHolderOrSkip(holderId, "nusawork.assign")
    if (!log) return
    if (log.holderKind !== "employee" || !log.employee || !log.asset) return

    // If already has nusaworkGroupId, assign was already synced.
    if (log.nusaworkGroupId) {
        logger.info(`[nusawork.handlers] Holder ${holderId} already has nusaworkGroupId ${log.nusaworkGroupId}, skipping assign`)
        return
    }

    const res = await nusaworkHelper.createAssetSync({
        employee_id: log.employee.employeeId,
        fields: {
            asset_code: log.asset.code,
            asset_name: log.asset.name,
            assign_date: formatNusaworkDateTime(log.assignedDate),
            assign_note: log.assignNote || undefined,
            asset_status: "Active",
        },
    })

    const groupId = res?.data?.id_group ?? res?.data?.id
    if (groupId) {
        await assetHolderService.updateNusaworkGroupId(log.id, Number(groupId))
        logger.info(`[nusawork.handlers] Synced assign for holder ${log.id} to Nusawork, saved id_group ${groupId}`)
    } else {
        logger.warn(`[nusawork.handlers] Nusawork createAssetSync did not return id_group for holder ${log.id}`, { response: res })
    }
})

queueService.registerHandler("nusawork.return", async (payload) => {
    const { holderId } = payload as { holderId: number }
    const log = await loadHolderOrSkip(holderId, "nusawork.return")
    if (!log) return
    if (log.holderKind !== "employee" || !log.employee || !log.returnedDate) return

    const groupId = await resolveNusaworkGroupId(log)
    await nusaworkHelper.returnAssetSync({
        employee_id: log.employee.employeeId,
        id_group: groupId,
        fields: {
            return_date: formatNusaworkDateTime(log.returnedDate),
            return_note: log.returnNote || undefined,
            asset_status: "Returned",
        },
    })
})

queueService.registerHandler("nusawork.update", async (payload) => {
    const { holderId } = payload as { holderId: number }
    const log = await loadHolderOrSkip(holderId, "nusawork.update")
    if (!log) return
    if (log.holderKind !== "employee" || !log.employee || !log.asset) return

    const statusValue = log.returnedDate ? "Returned" : "Active"
    const groupId = await resolveNusaworkGroupId(log)
    await nusaworkHelper.updateAssetSync({
        employee_id: log.employee.employeeId,
        id_group: groupId,
        fields: {
            asset_code: log.asset.code,
            asset_name: log.asset.name,
            assign_date: formatNusaworkDateTime(log.assignedDate),
            assign_note: log.assignNote || undefined,
            return_date: log.returnedDate ? formatNusaworkDateTime(log.returnedDate) : undefined,
            return_note: log.returnNote || undefined,
            asset_status: statusValue,
        },
    })
})

queueService.registerHandler("nusawork.delete", async (payload) => {
    const { holderId, employeeExternalId, nusaworkGroupId } = payload as {
        holderId: number
        employeeExternalId: string
        nusaworkGroupId?: number | null
    }

    let groupId = nusaworkGroupId
    if (!groupId) {
        const groups = await nusaworkHelper.getAssetSyncGroups(employeeExternalId)
        const group = groups.find((g) => g.items?.some((item) => item.key === "id_holder" && item.input?.value === String(holderId)))
        groupId = group?.id_group
    }

    if (!groupId) {
        logger.warn(`[nusawork.handlers] Could not find Nusawork note group to delete for holder ${holderId} (employee ${employeeExternalId})`)
        return
    }

    await nusaworkHelper.deleteAssetSync({ employee_id: employeeExternalId, id_group: groupId })
})
