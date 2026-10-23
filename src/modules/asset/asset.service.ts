import { Asset } from "./entities/asset.entity"
import { NotFoundException, BadRequestException, ConflictException } from "../../core/exceptions/base"
import { EntityManager } from "typeorm"
import { IAssetRepository } from "./interfaces/asset.repository.interface"
import { AssetFilter } from "./interfaces/asset.repository.interface"
import { minio } from "../../core/helpers/minio"
import { attachmentService } from "../attachment/attachment.module"
import { assetLogService } from "../asset-log/asset-log.module"
import { withTransaction } from "../../core/helpers/transaction"
import { AssetHolderService } from "../asset-holder/asset-holder.service"
import { AssetLocationService } from "../asset-location/asset-location.service"
import { AssetStatusService } from "../asset-status/asset-status.service"
import { EmployeeService } from "../employee/employee.service"
import type { Employee } from "../employee/entities/employee.entity"
import { OrganizationService } from "../organization/organization.service"
import { LocationService } from "../location/location.service"
import type { SubCategory } from "../sub-category/entities/sub-category.entity"

export class AssetService {
    constructor(
        private readonly repository: IAssetRepository,
        private readonly assetHolderService: AssetHolderService,
        private readonly assetLocationService: AssetLocationService,
        private readonly assetStatusService: AssetStatusService,
        private readonly employeeService: EmployeeService,
        private readonly organizationService: OrganizationService,
        private readonly locationService: LocationService
    ) {}


    async getAll(page: number, limit: number, q: string, sortBy?: string, order?: 'ASC' | 'DESC', filters?: AssetFilter): Promise<{ data: Asset[]; total: number }> {
        const { data, total } = await this.repository.findAll(page, limit, q, sortBy, order, filters)
        await Promise.all(data.map(asset => this.populateRelations(asset)))
        return { data, total }
    }

    async getAllForExport(q: string, sortBy?: string, order?: 'ASC' | 'DESC', filters?: AssetFilter): Promise<Asset[]> {
        const data = await this.repository.findAllWithoutPagination(q, sortBy, order, filters)
        await Promise.all(data.map(asset => this.populateRelations(asset)))
        return data
    }

    async getById(id: number): Promise<Asset> {
        const asset = await this.repository.findById(id)
        if (!asset) {
            throw new NotFoundException("Asset not found")
        }
        await this.populateRelations(asset)
        return asset
    }

    private async populateRelations(asset: Asset): Promise<void> {
        const labels = await this.repository.getLabelsForEntity("Asset", asset.id)
        asset.labels = labels.map(l => ({ id: l.id, key: l.key, value: l.value }))

        if (asset.hasHolder) {
            asset.activeHolder = await this.assetHolderService.findActiveHolder(asset.id)
        }

        if (asset.hasLocation) {
            asset.lastLocation = await this.assetLocationService.findLastLocation(asset.id)
        }

        asset.lastStatus = await this.assetStatusService.findLastStatus(asset.id)
    }

    /** Lightweight picker search — no relation population, capped result count. */
    async searchOptions(q: string, limit: number): Promise<Pick<Asset, 'id' | 'code' | 'name' | 'image'>[]> {
        return await this.repository.searchOptions(q, limit)
    }

    async checkCode(code: string, excludeId?: number): Promise<{ exists: boolean; id?: number }> {
        const asset = await this.repository.findByCode(code)
        if (asset && excludeId && asset.id === excludeId) return { exists: false }
        return { exists: !!asset, id: asset?.id }
    }

    async create(data: any): Promise<Asset> {
        const {
            employeeId,
            organizationId,
            assignedDate,
            assignNote,
            assignAttachmentIds,
            locationId,
            locationDate,
            locationNote,
            locationAttachmentIds,
            status: initialStatus,
            statusNote,
            attachmentIds,
            labels: newLabels,
            ...assetData
        } = data

        if (assetData.image !== undefined) {
            assetData.image = minio.sanitizePath(assetData.image) ?? undefined
        }

        if (employeeId && organizationId) {
            throw new BadRequestException("Cannot assign an asset to both an employee and an organization")
        }

        let holderName: string | null = null
        let employeeExists: Employee | null = null
        if (employeeId) {
            employeeExists = await this.employeeService.getById(employeeId)
            if (!employeeExists.isActive) {
                throw new BadRequestException("Cannot assign asset to inactive employee")
            }
            holderName = employeeExists.name
        } else if (organizationId) {
            const organizationExists = await this.organizationService.getById(organizationId)
            if (!organizationExists.isActive) {
                throw new BadRequestException("Cannot assign asset to inactive organization")
            }
            holderName = organizationExists.name
        }

        let locationExists: any = null
        if (locationId) {
            locationExists = await this.locationService.getById(locationId)
        }

        const resolvedAssignedDate = assignedDate || new Date().toISOString().split('T')[0]

        let holderId: number | undefined

        try {
            const asset = await withTransaction(async (manager) => {
                const asset = await this.repository.save(assetData, manager)

                await assetLogService.log({
                    assetId: asset.id,
                    module: "asset",
                    action: "create",
                    description: "Asset registered.",
                    createdByUserId: assetData.createdByUserId,
                }, manager)

                if (employeeId || organizationId) {
                    const holderKind = employeeId ? "employee" : "organization"
                    const log = await this.assetHolderService.save({
                        assetId: asset.id,
                        holderKind,
                        employeeId: employeeId || null,
                        organizationId: organizationId || null,
                        assignedDate: resolvedAssignedDate,
                        assignNote: assignNote || null,
                        createdByUserId: assetData.createdByUserId,
                    }, manager)
                    holderId = log.id

                    if (assignAttachmentIds && assignAttachmentIds.length > 0) {
                        await attachmentService.associate(assignAttachmentIds, "AssetHolder", log.id, manager)
                    }

                    await assetLogService.log({
                        assetId: asset.id,
                        module: "holder",
                        action: "assign",
                        description: `Asset assigned to ${holderKind} "${holderName}".`,
                        createdByUserId: assetData.createdByUserId,
                    }, manager)
                }

                if (locationId) {
                    const log = await this.assetLocationService.save({
                        assetId: asset.id,
                        locationId,
                        date: locationDate || new Date().toISOString().split('T')[0],
                        note: locationNote || null,
                        createdByUserId: assetData.createdByUserId,
                    }, manager)

                    if (locationAttachmentIds && locationAttachmentIds.length > 0) {
                        await attachmentService.associate(locationAttachmentIds, "AssetLocation", log.id, manager)
                    }

                    await assetLogService.log({
                        assetId: asset.id,
                        module: "location",
                        action: "relocate",
                        description: `Asset location set to "${locationExists.name}".`,
                        createdByUserId: assetData.createdByUserId,
                    }, manager)
                }

                if (initialStatus) {
                    await this.assetStatusService.save({
                        assetId: asset.id,
                        status: initialStatus,
                        note: statusNote || null,
                        createdByUserId: assetData.createdByUserId,
                    }, manager)

                    await assetLogService.log({
                        assetId: asset.id,
                        module: "status",
                        action: "update",
                        description: `Asset status set to "${initialStatus}".`,
                        createdByUserId: assetData.createdByUserId,
                    }, manager)
                }

                if (attachmentIds && attachmentIds.length > 0) {
                    await attachmentService.associate(attachmentIds, "Asset", asset.id, manager)
                }

                if (newLabels && newLabels.length > 0) {
                    await this.repository.saveLabels("Asset", asset.id, newLabels, manager)
                }

                return asset
            })

            if (employeeExists && holderId) {
                await this.assetHolderService.notifyNusaworkAssignment(holderId)
            }

            return await this.getById(asset.id)
        } catch (error: any) {
            if (error?.message?.includes("UNIQUE") || error?.message?.includes("Duplicate entry")) {
                throw new BadRequestException("Asset code must be unique")
            }
            throw error
        }
    }

    async update(id: number, data: Partial<Asset> & { attachmentIds?: number[] }, operatorId?: number): Promise<Asset> {
        const asset = await this.getById(id)

        const oldValue = { ...asset }

        if (data.image !== undefined) {
            data.image = minio.sanitizePath(data.image) ?? undefined
        }
        const newLabels = data.labels
        delete data.labels

        const newSubCategoryId = data.subCategoryId

        const attachmentIds = data.attachmentIds
        delete data.attachmentIds

        this.repository.merge(asset, data)
        if (newSubCategoryId !== undefined) {
            // The asset was loaded with the old relation. Keep the relation FK
            // aligned with the scalar field so TypeORM cannot restore the old ID.
            asset.subCategory = { id: newSubCategoryId } as SubCategory
        }
        try {
            await withTransaction(async (manager) => {
                await this.repository.save(asset, manager)

                if (newLabels !== undefined) {
                    await this.repository.deleteLabels("Asset", id, manager)
                    if (newLabels && newLabels.length > 0) {
                        await this.repository.saveLabels("Asset", id, newLabels as any, manager)
                    }
                }

                if (attachmentIds !== undefined) {
                    await attachmentService.disassociateOrphans("Asset", id, attachmentIds || [], manager)
                    if (attachmentIds && attachmentIds.length > 0) {
                        await attachmentService.associate(attachmentIds, "Asset", id, manager)
                    }
                }

                await assetLogService.log({
                    assetId: id,
                    module: "asset",
                    action: "update",
                    description: "Asset updated.",
                    createdByUserId: operatorId,
                    oldValue,
                    newValue: data,
                }, manager)
            })

            const updated = await this.getById(id)

            // Keep every historical Nusawork note for this asset's code/name in sync.
            if (oldValue.code !== updated.code || oldValue.name !== updated.name) {
                await this.assetHolderService.syncAssetEditToNusawork(id)
            }

            return updated
        } catch (error: any) {
            if (error?.message?.includes("UNIQUE") || error?.message?.includes("Duplicate entry")) {
                throw new BadRequestException("Asset code must be unique")
            }
            throw error
        }
    }

    async delete(id: number): Promise<void> {
        await this.getById(id)
        const holderCount = await this.repository.countActiveHolders(id)
        if (holderCount > 0) {
            throw new ConflictException(`Cannot delete asset, it is currently assigned to an employee`)
        }
        const locationCount = await this.repository.countLocations(id)
        if (locationCount > 0) {
            throw new ConflictException(`Cannot delete asset, ${locationCount} location history record(s) exist. Please delete them first`)
        }
        const maintenanceCount = await this.repository.countMaintenances(id)
        if (maintenanceCount > 0) {
            throw new ConflictException(`Cannot delete asset, ${maintenanceCount} maintenance record(s) exist. Please delete them first`)
        }
        await this.repository.deleteLabels("Asset", id)
        await this.repository.delete(id)
    }

    async bulkDelete(ids: number[]): Promise<{ deleted: number; failed: { id: number; message: string }[] }> {
        let deleted = 0
        const failed: { id: number; message: string }[] = []
        for (const id of ids) {
            try {
                await this.delete(id)
                deleted++
            } catch (error: any) {
                failed.push({ id, message: error?.message || 'Unknown error' })
            }
        }
        return { deleted, failed }
    }

    async save(data: Partial<Asset>, manager?: EntityManager): Promise<Asset> {
        return await this.repository.save(data, manager)
    }

    async getUniqueLabelKeys(): Promise<string[]> {
        return await this.repository.getUniqueLabelKeys("Asset")
    }

    async findByBleTagMac(mac: string): Promise<Asset | null> {
        return await this.repository.findByBleTagMac(mac)
    }
}
