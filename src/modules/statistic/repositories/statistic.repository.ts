import { SelectQueryBuilder } from "typeorm"
import { AppDataSource } from "../../../config/database"
import { Asset } from "../../asset/entities/asset.entity"
import { Category } from "../../category/entities/category.entity"
import { SubCategory } from "../../sub-category/entities/sub-category.entity"
import { Location } from "../../location/entities/location.entity"
import { Branch } from "../../branch/entities/branch.entity"
import { Employee } from "../../employee/entities/employee.entity"
import {
    AssetGroupStat,
    DepreciationReport,
    IStatisticRepository,
    LabeledCount,
    StatisticSummary,
} from "../interfaces/statistic.repository.interface"

const BOOK_VALUE_EXPRESSION = `COALESCE(SUM(
    CASE
        WHEN asset.useful_life IS NOT NULL AND asset.price IS NOT NULL AND asset.price > 0 AND asset.purchase_date IS NOT NULL AND asset.purchase_date != ''
        THEN GREATEST(asset.price - LEAST(ROUND(asset.price / (asset.useful_life * 12), 2) * TIMESTAMPDIFF(MONTH, asset.purchase_date, NOW()), asset.price), 0)
        ELSE COALESCE(asset.price, 0)
    END
), 0)`

const HAS_DEPRECIATION_CONDITION = "asset.useful_life IS NOT NULL AND asset.price IS NOT NULL AND asset.price > 0 AND asset.purchase_date IS NOT NULL AND asset.purchase_date != ''"

export class StatisticRepository implements IStatisticRepository {
    private applyStatusFilter(query: SelectQueryBuilder<Asset>, statuses?: string[]) {
        if (statuses?.length) {
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
                { statuses }
            )
        }
        return query
    }

    async getSummary(statuses?: string[]): Promise<StatisticSummary> {
        const assetRepo = AppDataSource.getRepository(Asset)
        const categoryRepo = AppDataSource.getRepository(Category)
        const subCategoryRepo = AppDataSource.getRepository(SubCategory)
        const locationRepo = AppDataSource.getRepository(Location)
        const branchRepo = AppDataSource.getRepository(Branch)
        const employeeRepo = AppDataSource.getRepository(Employee)

        const assetCountQuery = assetRepo.createQueryBuilder("asset")
        this.applyStatusFilter(assetCountQuery, statuses)

        const priceQuery = assetRepo.createQueryBuilder("asset")
            .select("COALESCE(SUM(asset.price), 0)", "totalPrice")
        this.applyStatusFilter(priceQuery, statuses)

        const bookValueQuery = assetRepo.createQueryBuilder("asset")
            .select(BOOK_VALUE_EXPRESSION, "totalBookValue")
        this.applyStatusFilter(bookValueQuery, statuses)

        const [
            totalAssets,
            totalCategories,
            totalSubCategories,
            totalLocations,
            totalBranches,
            totalActiveEmployees,
            priceResult,
            bookValueResult,
        ] = await Promise.all([
            assetCountQuery.getCount(),
            categoryRepo.count(),
            subCategoryRepo.count(),
            locationRepo.count(),
            branchRepo.count(),
            employeeRepo.count({ where: { isActive: true } }),
            priceQuery.getRawOne(),
            bookValueQuery.getRawOne(),
        ])

        const totalPrice = Number(priceResult?.totalPrice || 0)
        const totalBookValue = Number(bookValueResult?.totalBookValue || 0)

        return {
            totalAssets,
            totalPrice,
            totalBookValue,
            totalDepreciation: Number((totalPrice - totalBookValue).toFixed(2)),
            totalCategories,
            totalSubCategories,
            totalLocations,
            totalBranches,
            totalActiveEmployees,
        }
    }

    async getAssetsByCategory(statuses?: string[]): Promise<AssetGroupStat[]> {
        const query = AppDataSource.getRepository(Asset)
            .createQueryBuilder("asset")
            .innerJoin("asset.subCategory", "subCategory")
            .innerJoin("subCategory.category", "category")
            .select("category.id", "id")
            .addSelect("category.name", "name")
            .addSelect("COUNT(asset.id)", "count")
            .addSelect("COALESCE(SUM(asset.price), 0)", "totalPrice")
            .addSelect(BOOK_VALUE_EXPRESSION, "totalBookValue")
        this.applyStatusFilter(query, statuses)
        const result = await query
            .groupBy("category.id")
            .addGroupBy("category.name")
            .getRawMany()

        return result.map((row) => ({
            id: Number(row.id),
            name: row.name,
            count: Number(row.count),
            totalPrice: Number(row.totalPrice),
            totalBookValue: Number(row.totalBookValue),
        }))
    }

    async getAssetsByLocation(statuses?: string[]): Promise<AssetGroupStat[]> {
        const query = AppDataSource.getRepository(Asset)
            .createQueryBuilder("asset")
            .innerJoin(
                (qb) =>
                    qb
                        .select("al.asset_id", "asset_id")
                        .addSelect("al.location_id", "location_id")
                        .from("asset_locations", "al")
                        .innerJoin(
                            (sub) =>
                                sub
                                    .select("asset_id")
                                    .addSelect("MAX(id)", "max_id")
                                    .from("asset_locations", "al2")
                                    .groupBy("asset_id"),
                            "latest",
                            "al.id = latest.max_id",
                        ),
                "current_loc",
                "asset.id = current_loc.asset_id",
            )
            .innerJoin(Location, "location", "location.id = current_loc.location_id")
            .select("location.id", "id")
            .addSelect("location.name", "name")
            .addSelect("COUNT(asset.id)", "count")
            .addSelect("COALESCE(SUM(asset.price), 0)", "totalPrice")
            .addSelect(BOOK_VALUE_EXPRESSION, "totalBookValue")
        this.applyStatusFilter(query, statuses)
        const result = await query
            .groupBy("location.id")
            .addGroupBy("location.name")
            .getRawMany()

        return result.map((row) => ({
            id: Number(row.id),
            name: row.name,
            count: Number(row.count),
            totalPrice: Number(row.totalPrice),
            totalBookValue: Number(row.totalBookValue),
        }))
    }

    async getAssetsBySubCategory(statuses?: string[]): Promise<AssetGroupStat[]> {
        const query = AppDataSource.getRepository(Asset)
            .createQueryBuilder("asset")
            .innerJoin("asset.subCategory", "subCategory")
            .select("subCategory.id", "id")
            .addSelect("subCategory.name", "name")
            .addSelect("COUNT(asset.id)", "count")
            .addSelect("COALESCE(SUM(asset.price), 0)", "totalPrice")
        this.applyStatusFilter(query, statuses)
        const result = await query
            .groupBy("subCategory.id")
            .addGroupBy("subCategory.name")
            .orderBy("count", "DESC")
            .getRawMany()

        return result.map((row) => ({
            id: Number(row.id),
            name: row.name,
            count: Number(row.count),
            totalPrice: Number(row.totalPrice),
        }))
    }

    async getAssetAging(statuses?: string[]): Promise<LabeledCount[]> {
        const assetRepo = AppDataSource.getRepository(Asset)
        const now = new Date()

        const twoYearsAgo = new Date(now)
        twoYearsAgo.setFullYear(now.getFullYear() - 2)
        const fiveYearsAgo = new Date(now)
        fiveYearsAgo.setFullYear(now.getFullYear() - 5)

        const fmt = (d: Date) => d.toISOString().split("T")[0]

        const q1 = assetRepo.createQueryBuilder("asset").where("asset.purchase_date >= :date", { date: fmt(twoYearsAgo) })
        const q2 = assetRepo.createQueryBuilder("asset").where("asset.purchase_date < :from AND asset.purchase_date >= :to", { from: fmt(twoYearsAgo), to: fmt(fiveYearsAgo) })
        const q3 = assetRepo.createQueryBuilder("asset").where("asset.purchase_date < :date", { date: fmt(fiveYearsAgo) })
        this.applyStatusFilter(q1, statuses)
        this.applyStatusFilter(q2, statuses)
        this.applyStatusFilter(q3, statuses)

        const [zeroToTwo, threeToFive, overFive] = await Promise.all([
            q1.getCount(),
            q2.getCount(),
            q3.getCount(),
        ])

        return [
            { label: "0-2 Years", count: zeroToTwo },
            { label: "3-5 Years", count: threeToFive },
            { label: ">5 Years", count: overFive },
        ]
    }

    async getDataQuality(statuses?: string[]): Promise<LabeledCount[]> {
        const assetRepo = AppDataSource.getRepository(Asset)

        const makeQuery = (condition: string) => {
            const q = assetRepo.createQueryBuilder("asset").where(condition)
            this.applyStatusFilter(q, statuses)
            return q.getCount()
        }

        const [withoutImage, withoutPrice, withoutBrand, withoutModel, withoutPurchaseDate, withoutDepreciation] = await Promise.all([
            makeQuery("asset.image IS NULL OR asset.image = ''"),
            makeQuery("asset.price IS NULL OR asset.price = 0"),
            makeQuery("asset.brand IS NULL OR asset.brand = ''"),
            makeQuery("asset.model IS NULL OR asset.model = ''"),
            makeQuery("asset.purchase_date IS NULL OR asset.purchase_date = ''"),
            makeQuery("asset.useful_life IS NULL OR asset.price IS NULL OR asset.price = 0 OR asset.purchase_date IS NULL OR asset.purchase_date = ''"),
        ])

        return [
            { label: "Without Image", count: withoutImage },
            { label: "Without Price", count: withoutPrice },
            { label: "Without Brand", count: withoutBrand },
            { label: "Without Model", count: withoutModel },
            { label: "Without Purchase Date", count: withoutPurchaseDate },
            { label: "Without Depreciation", count: withoutDepreciation },
        ]
    }

    async getDepreciation(): Promise<DepreciationReport> {
        const assetRepo = AppDataSource.getRepository(Asset)

        const totalWithDepreciation = await assetRepo
            .createQueryBuilder("asset")
            .where(HAS_DEPRECIATION_CONDITION)
            .getCount()

        const monthlyDepResult = await assetRepo
            .createQueryBuilder("asset")
            .select("COALESCE(SUM(ROUND(asset.price / (asset.useful_life * 12), 2)), 0)", "total")
            .where(HAS_DEPRECIATION_CONDITION)
            .getRawOne()

        const accumulatedResult = await AppDataSource.query(`
            SELECT
                COALESCE(SUM(LEAST(ROUND(a.price / (a.useful_life * 12), 2) * TIMESTAMPDIFF(MONTH, a.purchase_date, NOW()), a.price)), 0) as totalAccumulated,
                COALESCE(SUM(GREATEST(a.price - LEAST(ROUND(a.price / (a.useful_life * 12), 2) * TIMESTAMPDIFF(MONTH, a.purchase_date, NOW()), a.price), 0)), 0) as totalBookValue
            FROM assets a
            WHERE a.useful_life IS NOT NULL AND a.price IS NOT NULL AND a.price > 0 AND a.purchase_date IS NOT NULL AND a.purchase_date != ''
        `)

        const summary = {
            totalWithDepreciation,
            totalMonthlyDepreciation: Number(Number(monthlyDepResult?.total || 0).toFixed(2)),
            totalAccumulatedDepreciation: Number(accumulatedResult[0]?.totalAccumulated || 0),
            totalBookValue: Number(accumulatedResult[0]?.totalBookValue || 0),
        }

        const totalAssets = await assetRepo.count()

        const fullyDepreciated = await AppDataSource.query(`
            SELECT COUNT(*) as count
            FROM assets a
            WHERE a.useful_life IS NOT NULL AND a.price IS NOT NULL AND a.price > 0 AND a.purchase_date IS NOT NULL AND a.purchase_date != ''
            AND ROUND(a.price / (a.useful_life * 12), 2) * TIMESTAMPDIFF(MONTH, a.purchase_date, NOW()) >= a.price
        `)

        const fullyDepreciatedCount = Number(fullyDepreciated[0]?.count || 0)
        const noDepreciation = totalAssets - totalWithDepreciation
        const hasDepreciation = totalWithDepreciation - fullyDepreciatedCount

        const statusBreakdown = [
            { label: "Has Depreciation", count: hasDepreciation },
            { label: "No Depreciation", count: noDepreciation },
            { label: "Fully Depreciated", count: fullyDepreciatedCount },
        ]

        const byCategoryResult = await AppDataSource.query(`
            SELECT
                c.name as name,
                COALESCE(SUM(a.price), 0) as originalPrice,
                COALESCE(SUM(GREATEST(a.price - LEAST(ROUND(a.price / (a.useful_life * 12), 2) * TIMESTAMPDIFF(MONTH, a.purchase_date, NOW()), a.price), 0)), 0) as bookValue
            FROM assets a
            INNER JOIN sub_categories sc ON a.sub_category_id = sc.id
            INNER JOIN categories c ON sc.category_id = c.id
            WHERE a.useful_life IS NOT NULL AND a.price IS NOT NULL AND a.price > 0 AND a.purchase_date IS NOT NULL AND a.purchase_date != ''
            GROUP BY c.id, c.name
            ORDER BY originalPrice DESC
        `)

        const byCategory = byCategoryResult.map((row: any) => ({
            name: row.name,
            originalPrice: Number(row.originalPrice),
            bookValue: Number(row.bookValue),
        }))

        return {
            summary,
            statusBreakdown,
            byCategory,
        }
    }
}
