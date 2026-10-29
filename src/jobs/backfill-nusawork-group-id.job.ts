/**
 * Backfill Nusawork Group IDs into `asset_holders.nusawork_group_id`.
 *
 * Scans all active (and optionally returned) employee asset assignments
 * that have not yet had their Nusawork note `id_group` cached.
 * Matches notes first by `id_holder == holder.id`, then falls back to `asset_code == asset.code`.
 *
 * Usage:
 *   bun run src/jobs/backfill-nusawork-group-id.job.ts
 *   bun run src/jobs/backfill-nusawork-group-id.job.ts --all  (includes already-returned holders)
 */
import { AppDataSource } from "../config/database"
import { AssetHolder } from "../modules/asset-holder/entities/asset-holder.entity"
import { nusaworkHelper } from "../core/helpers/nusawork"
import { logger } from "../core/helpers/logger"
import { IsNull } from "typeorm"

const includeReturned = process.argv.includes("--all")

function formatNusaworkDateTime(input: string): string {
    const dateOnlyMatch = input.match(/^(\d{4}-\d{2}-\d{2})$/)
    if (dateOnlyMatch) {
        return `${dateOnlyMatch[1]} 00:00:00`
    }
    const date = new Date(input)
    const pad = (n: number) => String(n).padStart(2, "0")
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

async function backfill() {
    logger.info("Initializing database connection...")
    await AppDataSource.initialize()

    const holderRepo = AppDataSource.getRepository(AssetHolder)

    const whereCondition: any = {
        holderKind: "employee",
        nusaworkGroupId: IsNull(),
    }

    if (!includeReturned) {
        whereCondition.returnedDate = IsNull()
    }

    const holders = await holderRepo.find({
        where: whereCondition,
        relations: ["employee", "asset"],
        order: { id: "ASC" },
    })

    logger.info(`Found ${holders.length} employee holder records needing nusawork_group_id (includeReturned=${includeReturned}).`)

    if (holders.length === 0) {
        logger.info("No records to backfill. Exiting.")
        process.exit(0)
    }

    // Cache groups per employeeId to minimize API requests
    const employeeGroupsCache = new Map<string, { id_group: number; items: { key: string; input: { value: string } }[] }[]>()

    let matchedCount = 0
    let skippedCount = 0
    let notFoundCount = 0

    for (let i = 0; i < holders.length; i++) {
        const holder = holders[i]
        const empExternalId = holder.employee?.employeeId

        if (!empExternalId) {
            logger.warn(`[${i + 1}/${holders.length}] Holder ${holder.id}: Employee has no external employeeId, skipping`)
            skippedCount++
            continue
        }

        if (!employeeGroupsCache.has(empExternalId)) {
            try {
                logger.info(`Fetching Nusawork notes for employee ${empExternalId} (${holder.employee?.name})...`)
                const groups = await nusaworkHelper.getAssetSyncGroups(empExternalId)
                employeeGroupsCache.set(empExternalId, groups)
            } catch (err: any) {
                logger.error(`Failed to fetch groups for employee ${empExternalId}: ${err?.message || err}`)
                employeeGroupsCache.set(empExternalId, [])
            }
        }

        const groups = employeeGroupsCache.get(empExternalId) || []

        // 1. Try matching by id_holder
        let matchedGroup = groups.find((g) =>
            g.items?.some((item) => item.key === "id_holder" && String(item.input?.value) === String(holder.id))
        )

        // 2. Fallback to asset_code
        if (!matchedGroup && holder.asset?.code) {
            matchedGroup = groups.find((g) =>
                g.items?.some((item) => item.key === "asset_code" && item.input?.value === holder.asset?.code)
            )
        }

        if (matchedGroup) {
            await holderRepo.update(holder.id, { nusaworkGroupId: matchedGroup.id_group })
            matchedCount++
            logger.info(`[${i + 1}/${holders.length}] Holder ${holder.id} (Asset: ${holder.asset?.code}) -> matched id_group ${matchedGroup.id_group}`)

            // Sync asset_status to Nusawork note
            const targetStatus = holder.returnedDate ? "Returned" : "Active"
            try {
                await nusaworkHelper.updateAssetSync({
                    employee_id: empExternalId,
                    id_group: matchedGroup.id_group,
                    fields: {
                        asset_code: holder.asset?.code || "",
                        asset_name: holder.asset?.name || "",
                        assign_date: formatNusaworkDateTime(holder.assignedDate),
                        assign_note: holder.assignNote || undefined,
                        return_date: holder.returnedDate ? formatNusaworkDateTime(holder.returnedDate) : undefined,
                        return_note: holder.returnNote || undefined,
                        asset_status: targetStatus,
                    },
                })
                logger.info(`  -> updated Nusawork note ${matchedGroup.id_group} asset_status to "${targetStatus}"`)
            } catch (err: any) {
                logger.warn(`  -> failed to update Nusawork asset_status for note ${matchedGroup.id_group}: ${err?.message || err}`)
            }
        } else {
            notFoundCount++
            logger.warn(`[${i + 1}/${holders.length}] Holder ${holder.id} (Asset: ${holder.asset?.code}): no matching note in Nusawork for ${empExternalId}`)
        }
    }

    logger.info("============================================================")
    logger.info(`Backfill complete: ${matchedCount} matched & updated, ${notFoundCount} not found, ${skippedCount} skipped.`)
    logger.info("============================================================")

    process.exit(0)
}

backfill().catch((err) => {
    logger.error("Backfill job crashed", { error: err?.message, stack: err?.stack })
    process.exit(1)
})
