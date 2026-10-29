import { AssetHolder } from "./entities/asset-holder.entity"
import { IAssetHolderRepository } from "./interfaces/asset-holder.repository.interface"
import { NotFoundException, BadRequestException } from "../../core/exceptions/base"
import { AttachmentService } from "../attachment/attachment.service"
import { Attachment } from "../attachment/entities/attachment.entity"
import { assetLogService } from "../asset-log/asset-log.module"
import { EmployeeService } from "../employee/employee.service"
import { OrganizationService } from "../organization/organization.service"
import { withTransaction } from "../../core/helpers/transaction"
import { EntityManager } from "typeorm"
import type { AssetHolderKind } from "../../core/enums"
import type { Employee } from "../employee/entities/employee.entity"
import { QueueService } from "../queue/queue.service"

export class AssetHolderService {
    constructor(
        private readonly repository: IAssetHolderRepository,
        private readonly attachmentService: AttachmentService,
        private readonly employeeService: EmployeeService,
        private readonly organizationService: OrganizationService,
        private readonly queueService: QueueService
    ) {}

    async getAll(
        page: number,
        limit: number,
        q: string,
        sortBy?: string,
        order?: 'ASC' | 'DESC',
        assetId?: number,
        employeeId?: number,
        organizationId?: number
    ): Promise<{ data: { log: AssetHolder; attachments: Attachment[] }[]; total: number }> {
        const { data, total } = await this.repository.findAll(page, limit, q, sortBy, order, assetId, employeeId, organizationId)

        const mapped = await Promise.all(data.map(async (log) => {
            const attachments = await this.attachmentService.getForEntity("AssetHolder", log.id)
            return { log, attachments }
        }))

        return { data: mapped, total }
    }

    async getById(id: number): Promise<{ log: AssetHolder; attachments: Attachment[] }> {
        const log = await this.repository.findById(id)
        if (!log) {
            throw new NotFoundException("Asset assignment record not found")
        }
        const attachments = await this.attachmentService.getForEntity("AssetHolder", id)
        return { log, attachments }
    }

    async findActiveByAssetId(assetId: number): Promise<{ log: AssetHolder; attachments: Attachment[] } | null> {
        const log = await this.repository.findActiveByAssetId(assetId)
        if (!log) return null
        const attachments = await this.attachmentService.getForEntity("AssetHolder", log.id)
        return { log, attachments }
    }

    async findActiveByHandoverId(handoverId: number): Promise<AssetHolder[]> {
        return await this.repository.findActiveByHandoverId(handoverId)
    }

    async create(data: Partial<AssetHolder> & { holderKind: AssetHolderKind; attachmentIds?: number[] }): Promise<AssetHolder> {
        const assetExists = await this.repository.assetExists(data.assetId!)
        if (!assetExists) {
            throw new NotFoundException("Asset not found")
        }

        let holderName: string
        let employee: Employee | null = null
        if (data.holderKind === "employee") {
            employee = await this.employeeService.getById(data.employeeId!)
            if (!employee.isActive) {
                throw new BadRequestException("Cannot assign asset to inactive employee")
            }
            holderName = employee.name
        } else {
            const organization = await this.organizationService.getById(data.organizationId!)
            if (!organization.isActive) {
                throw new BadRequestException("Cannot assign asset to inactive organization")
            }
            holderName = organization.name
        }

        const activeLog = await this.repository.findActiveByAssetId(data.assetId!)
        if (activeLog) {
            throw new BadRequestException("Asset is currently assigned and must be returned first")
        }

        const pendingAssetIds = await this.repository.findPendingHandoverAssetIds()
        if (pendingAssetIds.includes(data.assetId!)) {
            throw new BadRequestException("Asset is awaiting handover approval and cannot be assigned")
        }

        const lastStatus = await this.repository.findLastAssetStatus(data.assetId!)
        if (lastStatus && lastStatus !== "active") {
            throw new BadRequestException(`Cannot assign holder: asset status is "${lastStatus}", must be "active"`)
        }

        const log = await withTransaction(async (manager) => {
            const log = await this.repository.save({
                assetId: data.assetId,
                holderKind: data.holderKind,
                employeeId: data.holderKind === "employee" ? data.employeeId : null,
                organizationId: data.holderKind === "organization" ? data.organizationId : null,
                assignedDate: data.assignedDate,
                assignNote: data.assignNote,
                createdByUserId: data.createdByUserId,
            }, manager)

            if (data.attachmentIds && data.attachmentIds.length > 0) {
                await this.attachmentService.associate(data.attachmentIds, "AssetHolder", log.id, manager)
            }

            await assetLogService.log({
                assetId: data.assetId!,
                module: "holder",
                action: "assign",
                description: `Asset assigned to ${data.holderKind} "${holderName}".`,
                createdByUserId: data.createdByUserId,
                newValue: data,
            }, manager)

            return log
        })

        // book.service.ts also reaches this via create(), so notify regardless of caller.
        if (employee) {
            await this.notifyNusaworkAssignment(log.id)
        }

        const reloaded = await this.repository.findById(log.id)
        if (!reloaded) throw new NotFoundException("Created assignment could not be loaded")
        return reloaded
    }

    /** Queues a Nusawork sync job; the actual HTTP call runs in the queue worker, never inline here. */
    async notifyNusaworkAssignment(holderId: number): Promise<void> {
        await this.queueService.push("nusawork.assign", { holderId })
    }

    async notifyNusaworkReturn(holderId: number): Promise<void> {
        await this.queueService.push("nusawork.return", { holderId })
    }

    private async syncHolderToNusawork(holderId: number): Promise<void> {
        await this.queueService.push("nusawork.update", { holderId })
    }

    /** One job per holder — a failure on one doesn't affect the others. */
    async syncAssetEditToNusawork(assetId: number): Promise<void> {
        const holders = await this.repository.findEmployeeHeldByAssetId(assetId)
        for (const holder of holders) {
            await this.syncHolderToNusawork(holder.id)
        }
    }

    async returnAsset(
        id: number,
        data: { returnedDate: string; returnNote?: string; returnedByUserId?: number; attachmentIds?: number[] }
    ): Promise<AssetHolder> {
        const { log } = await this.getById(id)
        if (log.returnedDate) {
            throw new BadRequestException("Asset has already been returned")
        }

        await withTransaction(async (manager) => {
            log.returnedDate = data.returnedDate
            log.returnNote = data.returnNote || null
            log.returnedByUserId = data.returnedByUserId || null

            await this.repository.save(log, manager)

            if (data.attachmentIds && data.attachmentIds.length > 0) {
                await this.attachmentService.associate(data.attachmentIds, "AssetHolder", log.id, manager)
            }

            const holderName = log.holderKind === "employee" ? log.employee?.name : log.organization?.name
            await assetLogService.log({
                assetId: log.assetId,
                module: "holder",
                action: "return",
                description: `Asset returned from ${log.holderKind} "${holderName}".`,
                createdByUserId: data.returnedByUserId,
                oldValue: { ...log },
                newValue: data,
            }, manager)
        })

        // book.service.ts also reaches this via returnAsset(), so notify regardless of caller.
        if (log.holderKind === "employee" && log.employee) {
            await this.notifyNusaworkReturn(log.id)
        }

        const reloaded = await this.repository.findById(log.id)
        if (!reloaded) throw new NotFoundException("Updated assignment could not be loaded")
        return reloaded
    }

    async update(
        id: number,
        data: Partial<AssetHolder> & { attachmentIds?: number[] },
        operatorId?: number
    ): Promise<AssetHolder> {
        const { log } = await this.getById(id)
        const oldSnapshot = { ...log }
        const isReturned = !!log.returnedDate

        // Return fields only make sense once the asset has actually been returned.
        if (!isReturned && (data.returnedDate !== undefined || data.returnNote !== undefined)) {
            throw new BadRequestException("Return data can only be edited after the asset has been returned")
        }

        const touchingHolder = data.holderKind !== undefined || data.employeeId !== undefined || data.organizationId !== undefined
        let holderKind = log.holderKind
        let employeeId = log.employeeId
        let organizationId = log.organizationId
        let holderName = log.holderKind === "employee" ? log.employee?.name : log.organization?.name

        if (touchingHolder) {
            holderKind = data.holderKind ?? log.holderKind
            if (holderKind === "employee") {
                employeeId = data.employeeId !== undefined ? data.employeeId : log.employeeId
                organizationId = null
                if (!employeeId) throw new BadRequestException("Employee ID is required")
                const employee = await this.employeeService.getById(employeeId)
                if (!employee.isActive) throw new BadRequestException("Cannot assign asset to inactive employee")
                holderName = employee.name
            } else {
                organizationId = data.organizationId !== undefined ? data.organizationId : log.organizationId
                employeeId = null
                if (!organizationId) throw new BadRequestException("Organization ID is required")
                const organization = await this.organizationService.getById(organizationId)
                if (!organization.isActive) throw new BadRequestException("Cannot assign asset to inactive organization")
                holderName = organization.name
            }
        }

        await withTransaction(async (manager) => {
            // Clear eagerly-loaded relations first — save() otherwise prioritizes the stale relation over the merged scalar id.
            log.employee = undefined as any
            log.organization = undefined as any
            this.repository.merge(log, {
                holderKind,
                employeeId,
                organizationId,
                assignedDate: data.assignedDate ?? log.assignedDate,
                assignNote: data.assignNote !== undefined ? data.assignNote : log.assignNote,
                ...(isReturned ? {
                    returnedDate: data.returnedDate ?? log.returnedDate,
                    returnNote: data.returnNote !== undefined ? data.returnNote : log.returnNote,
                } : {}),
            })

            await this.repository.save(log, manager)

            if (data.attachmentIds !== undefined) {
                await this.attachmentService.disassociateOrphans("AssetHolder", id, data.attachmentIds, manager)
                await this.attachmentService.associate(data.attachmentIds, "AssetHolder", id, manager)
            }

            await assetLogService.log({
                assetId: log.assetId,
                module: "holder",
                action: "update",
                description: `Asset holder record updated (${holderKind} "${holderName}").`,
                createdByUserId: operatorId,
                oldValue: oldSnapshot,
                newValue: data,
            }, manager)
        })

        const reloaded = await this.repository.findById(id)
        if (!reloaded) throw new NotFoundException("Updated assignment could not be loaded")

        // Keep the Nusawork note in sync with whatever just changed (dates, notes, etc).
        await this.syncHolderToNusawork(reloaded.id)

        return reloaded
    }

    async delete(id: number, operatorId?: number): Promise<void> {
        const { log } = await this.getById(id)

        await withTransaction(async (manager) => {
            await this.attachmentService.disassociateOrphans("AssetHolder", id, [], manager)
            await this.repository.delete(id, manager)

            const holderName = log.holderKind === "employee" ? log.employee?.name : log.organization?.name
            await assetLogService.log({
                assetId: log.assetId,
                module: "holder",
                action: "delete",
                description: `Asset holder record deleted (${log.holderKind} "${holderName}").`,
                createdByUserId: operatorId,
                oldValue: { ...log },
            }, manager)
        })

        // Record is already gone, so the employee's external id and cached note group travel in the payload.
        if (log.holderKind === "employee" && log.employee) {
            await this.queueService.push("nusawork.delete", {
                holderId: log.id,
                employeeExternalId: log.employee.employeeId,
                nusaworkGroupId: log.nusaworkGroupId ?? undefined,
            })
        }
    }

    async updateNusaworkGroupId(id: number, nusaworkGroupId: number): Promise<void> {
        await this.repository.save({ id, nusaworkGroupId })
    }

    async findActiveHolder(assetId: number): Promise<AssetHolder | null> {
        return await this.repository.findActiveByAssetId(assetId)
    }

    async save(data: Partial<AssetHolder>, manager?: EntityManager): Promise<AssetHolder> {
        return await this.repository.save(data, manager)
    }
}
