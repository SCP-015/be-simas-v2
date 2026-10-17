import { EntityManager, IsNull, Repository } from "typeorm"
import { AppDataSource } from "../../../config/database"
import { Asset } from "../entities/asset.entity"
import { AssetLabel } from "../entities/asset-label.entity"
import { IAssetRepository, AssetFilter } from "../interfaces/asset.repository.interface"
import { AssetHolder } from "../../asset-holder/entities/asset-holder.entity"
import { AssetLocation } from "../../asset-location/entities/asset-location.entity"
import { AssetMaintenance } from "../../asset-maintenance/entities/asset-maintenance.entity"
import { Employee } from "../../employee/entities/employee.entity"
import { Organization } from "../../organization/entities/organization.entity"
import { Location } from "../../location/entities/location.entity"
import { Branch } from "../../branch/entities/branch.entity"
import { SubCategory } from "../../sub-category/entities/sub-category.entity"

export class AssetRepository implements IAssetRepository {
    private readonly repository: Repository<Asset>

    constructor() {
        this.repository = AppDataSource.getRepository(Asset)
    }

    private buildQuery(q: string, sortBy?: string, order?: 'ASC' | 'DESC', filters?: AssetFilter) {
        const query = this.repository.createQueryBuilder("asset")
            .leftJoinAndSelect("asset.subCategory", "subCategory")
            .leftJoinAndSelect("subCategory.category", "category")
            .leftJoinAndSelect("asset.createdBy", "createdBy")
            .leftJoin(AssetHolder, "activeHolder", "activeHolder.assetId = asset.id AND activeHolder.returnedDate IS NULL")
            .leftJoin(Employee, "activeEmployee", "activeEmployee.id = activeHolder.employeeId")
            .leftJoin(Organization, "activeOrganization", "activeOrganization.id = activeHolder.organizationId")
            .leftJoin(
                "(SELECT asset_id, MAX(id) AS latest_id FROM asset_locations GROUP BY asset_id)",
                "latestAssetLocation",
                "latestAssetLocation.asset_id = asset.id"
            )
            .leftJoin(AssetLocation, "lastAssetLocation", "lastAssetLocation.id = latestAssetLocation.latest_id")
            .leftJoin(Location, "lastLoc", "lastLoc.id = lastAssetLocation.locationId")
            .leftJoin(Branch, "lastBranch", "lastBranch.id = lastLoc.branchId")
            .leftJoin("asset_labels", "searchLabel", "searchLabel.entityType = 'Asset' AND searchLabel.entityId = asset.id")
            .addSelect("activeEmployee.name")
            .addSelect("activeOrganization.name")
            .addSelect("lastLoc.name")

        if (q) {
            query.where(
                "(asset.name LIKE :q OR asset.code LIKE :q OR asset.brand LIKE :q OR asset.model LIKE :q OR asset.bleTagMac LIKE :q OR asset.description LIKE :q OR subCategory.name LIKE :q OR category.name LIKE :q OR activeEmployee.name LIKE :q OR activeEmployee.employeeId LIKE :q OR activeOrganization.name LIKE :q OR lastLoc.name LIKE :q OR lastLoc.mistZoneId LIKE :q OR lastBranch.name LIKE :q OR searchLabel.key LIKE :q OR searchLabel.value LIKE :q)",
                { q: `%${q}%` }
            )
        }

        query.distinct(true)

        if (filters?.categoryIds?.length) {
            query.andWhere("subCategory.categoryId IN (:...categoryIds)", { categoryIds: filters.categoryIds })
        }
        if (filters?.subCategoryIds?.length) {
            query.andWhere("asset.subCategoryId IN (:...subCategoryIds)", { subCategoryIds: filters.subCategoryIds })
        }
        if (filters?.branchIds?.length) {
            query.andWhere("lastLoc.branchId IN (:...branchIds)", { branchIds: filters.branchIds })
        }
        if (filters?.locationIds?.length) {
            query.andWhere("lastAssetLocation.locationId IN (:...locationIds)", { locationIds: filters.locationIds })
        }
        if (filters?.status?.length) {
            query.andWhere(
                `EXISTS (
                    SELECT 1
                    FROM asset_statuses latestStatus
                    INNER JOIN (
                        SELECT asset_id, MAX(id) AS latest_id
                        FROM asset_statuses
                        GROUP BY asset_id
                    ) latestStatusId
                        ON latestStatusId.asset_id = latestStatus.asset_id
                        AND latestStatusId.latest_id = latestStatus.id
                    WHERE latestStatus.asset_id = asset.id
                      AND latestStatus.status IN (:...statuses)
                )`,
                { statuses: filters.status }
            )
        }
        if (filters?.holderStatus === 'has_holder') {
            if (filters?.holderType === 'historical_holder') {
                // Any holder ever assigned (active or returned)
                query.andWhere("EXISTS (SELECT 1 FROM asset_holders ah WHERE ah.asset_id = asset.id)")
            } else {
                // Default: active holder only
                query.andWhere("activeHolder.id IS NOT NULL")
            }
        }
        if (filters?.holderStatus === 'no_holder') {
            query.andWhere("activeHolder.id IS NULL")
        }
        if (filters?.holderId) {
            const holderColumn = filters?.holderKind === 'organization' ? 'organizationId' : 'employeeId'
            const holderColumnSql = filters?.holderKind === 'organization' ? 'organization_id' : 'employee_id'
            if (filters?.holderType === 'historical_holder') {
                // Filter by holder across ALL holder records
                query.andWhere(`EXISTS (SELECT 1 FROM asset_holders ah WHERE ah.asset_id = asset.id AND ah.${holderColumnSql} = :holderId)`, { holderId: filters.holderId })
            } else {
                // Filter by holder on active holder only
                query.andWhere(`activeHolder.${holderColumn} = :holderId`, { holderId: filters.holderId })
            }
        }
        if (filters?.bleTagStatus === 'has_ble_tag') {
            query.andWhere("asset.bleTagMac IS NOT NULL AND asset.bleTagMac != ''")
        }
        if (filters?.bleTagStatus === 'no_ble_tag') {
            query.andWhere("(asset.bleTagMac IS NULL OR asset.bleTagMac = '')")
        }
        if (filters?.priceMin !== undefined || filters?.priceMax !== undefined) {
            query.andWhere("asset.price IS NOT NULL AND asset.price > 0")
        }
        if (filters?.priceMin !== undefined) {
            query.andWhere("asset.price >= :priceMin", { priceMin: filters.priceMin })
        }
        if (filters?.priceMax !== undefined) {
            query.andWhere("asset.price <= :priceMax", { priceMax: filters.priceMax })
        }
        if (filters?.purchaseDateFrom || filters?.purchaseDateTo) {
            query.andWhere("asset.purchaseDate IS NOT NULL AND asset.purchaseDate != ''")
        }
        if (filters?.purchaseDateFrom) {
            query.andWhere("asset.purchaseDate >= :purchaseDateFrom", { purchaseDateFrom: filters.purchaseDateFrom })
        }
        if (filters?.purchaseDateTo) {
            query.andWhere("asset.purchaseDate <= :purchaseDateTo", { purchaseDateTo: filters.purchaseDateTo })
        }
        if (filters?.labels?.length) {
            filters.labels.forEach((label, i) => {
                query.andWhere(
                    `EXISTS (SELECT 1 FROM asset_labels al${i} WHERE al${i}.entity_type = 'Asset' AND al${i}.entity_id = asset.id AND al${i}.key = :lk${i} AND al${i}.value LIKE :lv${i})`,
                    { [`lk${i}`]: label.key, [`lv${i}`]: `%${label.value}%` }
                )
            })
        }
        if (filters?.missingFields?.length) {
            const fieldMap: Record<string, string> = {
                image: "asset.image IS NULL OR asset.image = ''",
                price: "asset.price IS NULL OR asset.price = 0",
                brand: "asset.brand IS NULL OR asset.brand = ''",
                model: "asset.model IS NULL OR asset.model = ''",
                purchaseDate: "asset.purchase_date IS NULL OR asset.purchase_date = ''",
            }
            for (const field of filters.missingFields) {
                const condition = fieldMap[field]
                if (condition) {
                    query.andWhere(`(${condition})`)
                }
            }
        }
        if (filters?.depreciationStatus === 'has_depreciation') {
            query.andWhere("asset.useful_life IS NOT NULL AND asset.price IS NOT NULL AND asset.price > 0 AND asset.purchase_date IS NOT NULL AND asset.purchase_date != ''")
        }
        if (filters?.depreciationStatus === 'no_depreciation') {
            query.andWhere("(asset.useful_life IS NULL OR asset.price IS NULL OR asset.price = 0 OR asset.purchase_date IS NULL OR asset.purchase_date = '')")
        }
        if (filters?.depreciationStatus === 'fully_depreciated') {
            query.andWhere("asset.useful_life IS NOT NULL AND asset.price IS NOT NULL AND asset.price > 0 AND asset.purchase_date IS NOT NULL AND asset.purchase_date != ''")
            query.andWhere(
                `ROUND(asset.price / (asset.useful_life * 12)) * TIMESTAMPDIFF(MONTH, asset.purchase_date, NOW()) >= asset.price`
            )
        }

        if (filters?.usefulLifeOp && filters?.usefulLifeYears != null) {
            const op = filters.usefulLifeOp === '=' ? '=' : filters.usefulLifeOp === '<' ? '<' : '>'
            query.andWhere(`asset.useful_life IS NOT NULL AND asset.useful_life ${op} :usefulLifeYears`, { usefulLifeYears: filters.usefulLifeYears })
        }

        // Monthly depreciation range: price / (useful_life * 12)
        const monthlyDepExpr = `ROUND(asset.price / (asset.useful_life * 12), 2)`
        const depPrecondition = `asset.useful_life IS NOT NULL AND asset.price IS NOT NULL AND asset.price > 0 AND asset.purchase_date IS NOT NULL AND asset.purchase_date != ''`
        if (filters?.monthlyDepMin != null) {
            query.andWhere(`${depPrecondition} AND ${monthlyDepExpr} >= :monthlyDepMin`, { monthlyDepMin: filters.monthlyDepMin })
        }
        if (filters?.monthlyDepMax != null) {
            query.andWhere(`${depPrecondition} AND ${monthlyDepExpr} <= :monthlyDepMax`, { monthlyDepMax: filters.monthlyDepMax })
        }

        // Accumulated depreciation range: MIN(monthlyDep * months_elapsed, price)
        const accDepExpr = `LEAST(${monthlyDepExpr} * TIMESTAMPDIFF(MONTH, asset.purchase_date, NOW()), asset.price)`
        if (filters?.accumulatedDepMin != null) {
            query.andWhere(`${depPrecondition} AND ${accDepExpr} >= :accumulatedDepMin`, { accumulatedDepMin: filters.accumulatedDepMin })
        }
        if (filters?.accumulatedDepMax != null) {
            query.andWhere(`${depPrecondition} AND ${accDepExpr} <= :accumulatedDepMax`, { accumulatedDepMax: filters.accumulatedDepMax })
        }

        // Book value range: MAX(price - accumulated, 0)
        const bookValExpr = `GREATEST(asset.price - ${accDepExpr}, 0)`
        if (filters?.bookValueMin != null) {
            query.andWhere(`${depPrecondition} AND ${bookValExpr} >= :bookValueMin`, { bookValueMin: filters.bookValueMin })
        }
        if (filters?.bookValueMax != null) {
            query.andWhere(`${depPrecondition} AND ${bookValExpr} <= :bookValueMax`, { bookValueMax: filters.bookValueMax })
        }

        const sortColumnMap: Record<string, string> = {
            name: "asset.name",
            code: "asset.code",
            brand: "asset.brand",
            model: "asset.model",
            price: "asset.price",
            purchaseDate: "asset.purchaseDate",
            createdAt: "asset.createdAt",
            category: "category.name",
            subCategory: "subCategory.name",
            location: "lastLoc.name",
            holder: "COALESCE(activeEmployee.name, activeOrganization.name)",
            lastLocation: "lastLoc.name",
            activeHolder: "COALESCE(activeEmployee.name, activeOrganization.name)",
        }

        const sortOrder = order === 'ASC' ? 'ASC' : 'DESC'
        if (sortBy && sortBy.startsWith("label:")) {
            const labelKey = sortBy.substring(6)
            query.leftJoin(AssetLabel, "sortByLabel", "sortByLabel.entityType = 'Asset' AND sortByLabel.entityId = asset.id AND sortByLabel.key = :sortByLabelKey", { sortByLabelKey: labelKey })
            query.addSelect("sortByLabel.value")
            query.orderBy("sortByLabel.value", sortOrder)
        } else if (sortBy === 'bookValue') {
            query.addSelect(
                `CASE WHEN asset.price IS NOT NULL AND asset.useful_life IS NOT NULL AND asset.purchase_date IS NOT NULL
                    THEN GREATEST(asset.price - ROUND(asset.price / (asset.useful_life * 12)) * (TIMESTAMPDIFF(MONTH, asset.purchase_date, NOW())), 0)
                    ELSE NULL END`,
                "computedBookValue"
            )
            query.orderBy("computedBookValue", sortOrder)
        } else {
            const sortColumn = sortColumnMap[sortBy || ''] || "asset.id"
            query.orderBy(sortColumn, sortOrder)
        }

        return query
    }

    async findAll(page: number, limit: number, q: string, sortBy?: string, order?: 'ASC' | 'DESC', filters?: AssetFilter): Promise<{ data: Asset[]; total: number }> {
        const query = this.buildQuery(q, sortBy, order, filters)
        const total = await query.getCount()
        const offset = (page - 1) * limit
        const data = await query.skip(offset).take(limit).getMany()
        return { data, total }
    }

    async findAllWithoutPagination(q: string, sortBy?: string, order?: 'ASC' | 'DESC', filters?: AssetFilter): Promise<Asset[]> {
        const query = this.buildQuery(q, sortBy, order, filters)
        return await query.getMany()
    }

    async searchOptions(q: string, limit: number): Promise<Pick<Asset, 'id' | 'code' | 'name' | 'image'>[]> {
        const query = this.repository
            .createQueryBuilder("asset")
            .select(["asset.id", "asset.code", "asset.name", "asset.image"])
            .orderBy("asset.name", "ASC")
            .take(limit)

        if (q) {
            query.where("(asset.name LIKE :q OR asset.code LIKE :q)", { q: `%${q}%` })
        }

        return await query.getMany()
    }

    async findById(id: number): Promise<Asset | null> {
        return await this.repository.findOne({
            where: { id },
            relations: ["subCategory", "subCategory.category", "createdBy"]
        })
    }

    async findByCode(code: string): Promise<Asset | null> {
        return await this.repository.findOne({ where: { code } })
    }

    async findByBleTagMac(mac: string): Promise<Asset | null> {
        return await this.repository.findOne({ where: { bleTagMac: mac } })
    }

    async save(data: Partial<Asset>, manager?: EntityManager): Promise<Asset> {
        const repo = manager ? manager.getRepository(Asset) : this.repository
        return await repo.save(data)
    }

    merge(entity: Asset, data: Partial<Asset>): Asset {
        return this.repository.merge(entity, data)
    }

    async delete(id: number): Promise<void> {
        await this.repository.delete(id)
    }

    async countActiveHolders(assetId: number): Promise<number> {
        return await AppDataSource.getRepository(AssetHolder).count({ where: { assetId, returnedDate: IsNull() } })
    }

    async countLocations(assetId: number): Promise<number> {
        return await AppDataSource.getRepository(AssetLocation).count({ where: { assetId } })
    }

    async countMaintenances(assetId: number): Promise<number> {
        return await AppDataSource.getRepository(AssetMaintenance).count({ where: { assetId } })
    }

    async findSubCategoriesWithCategory(): Promise<SubCategory[]> {
        return await AppDataSource.getRepository(SubCategory)
            .createQueryBuilder('sc')
            .leftJoinAndSelect('sc.category', 'cat')
            .orderBy('cat.name', 'ASC')
            .addOrderBy('sc.name', 'ASC')
            .getMany()
    }

    async deleteLabels(entityType: string, entityId: number, manager?: EntityManager): Promise<void> {
        const repo = manager ? manager.getRepository(AssetLabel) : AppDataSource.getRepository(AssetLabel)
        await repo.delete({ entityType, entityId })
    }

    async saveLabels(entityType: string, entityId: number, labels: { key: string; value: string }[], manager?: EntityManager): Promise<void> {
        const repo = manager ? manager.getRepository(AssetLabel) : AppDataSource.getRepository(AssetLabel)
        const entities = labels.map(l => repo.create({ key: l.key, value: l.value, entityType, entityId }))
        await repo.save(entities)
    }

    async getLabelsForEntity(entityType: string, entityId: number): Promise<AssetLabel[]> {
        return await AppDataSource.getRepository(AssetLabel).find({ where: { entityType, entityId } })
    }

    async getLabelsForEntities(entityType: string, entityIds: number[]): Promise<Map<number, AssetLabel[]>> {
        if (entityIds.length === 0) return new Map()
        const labels = await AppDataSource.getRepository(AssetLabel)
            .createQueryBuilder("label")
            .where("label.entityType = :entityType AND label.entityId IN (:...entityIds)", { entityType, entityIds })
            .getMany()
        const map = new Map<number, AssetLabel[]>()
        for (const label of labels) {
            const arr = map.get(label.entityId) || []
            arr.push(label)
            map.set(label.entityId, arr)
        }
        return map
    }

    async getUniqueLabelKeys(entityType: string): Promise<string[]> {
        const result = await AppDataSource.getRepository(AssetLabel).createQueryBuilder("label")
            .select("DISTINCT label.key", "key")
            .where("label.entityType = :entityType AND label.key IS NOT NULL AND label.key != ''", { entityType })
            .orderBy("label.key", "ASC")
            .getRawMany()
        return result.map(r => r.key)
    }
}
