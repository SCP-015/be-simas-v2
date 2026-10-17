import { EntityManager, Repository } from "typeorm"
import { AppDataSource } from "../../../config/database"
import { Handover } from "../entities/handover.entity"
import { HandoverItem } from "../entities/handover-item.entity"
import { HandoverStockItem } from "../entities/handover-stock-item.entity"
import { HandoverCustomItem } from "../entities/handover-custom-item.entity"
import { IHandoverRepository, HandoverFilter } from "../interfaces/handover.repository.interface"

export class TypeOrmHandoverRepository implements IHandoverRepository {
    private readonly repository: Repository<Handover>
    private readonly itemRepository: Repository<HandoverItem>
    private readonly stockItemRepository: Repository<HandoverStockItem>
    private readonly customItemRepository: Repository<HandoverCustomItem>

    constructor() {
        this.repository = AppDataSource.getRepository(Handover)
        this.itemRepository = AppDataSource.getRepository(HandoverItem)
        this.stockItemRepository = AppDataSource.getRepository(HandoverStockItem)
        this.customItemRepository = AppDataSource.getRepository(HandoverCustomItem)
    }

    async findAll(
        page: number,
        limit: number,
        q: string,
        sortBy?: string,
        order?: 'ASC' | 'DESC',
        filters?: HandoverFilter
    ): Promise<{ data: Handover[]; total: number }> {
        const offset = (page - 1) * limit

        const query = this.repository.createQueryBuilder("handover")
            .leftJoinAndSelect("handover.items", "items")
            .leftJoinAndSelect("items.asset", "asset")
            .leftJoinAndSelect("handover.stockItems", "stockItems")
            .leftJoinAndSelect("stockItems.variant", "inventoryVariant")
            .leftJoinAndSelect("inventoryVariant.inventory", "inventory")
            .leftJoinAndSelect("stockItems.branch", "stockBranch")
            .leftJoinAndSelect("handover.customItems", "customItems")
            .leftJoinAndSelect("handover.receivedBy", "receivedBy")
            .leftJoinAndSelect("handover.handedOverBy", "handedOverBy")
            .leftJoinAndSelect("handover.createdBy", "createdBy")

        if (q) {
            query.where(
                "(handover.note LIKE :q OR asset.name LIKE :q OR asset.code LIKE :q OR receivedBy.name LIKE :q OR handedOverBy.name LIKE :q)",
                { q: `%${q}%` }
            )
        }

        if (filters?.status) {
            query.andWhere("handover.status = :status", { status: filters.status })
        }

        if (filters?.transactionType) {
            query.andWhere("handover.transactionType = :transactionType", { transactionType: filters.transactionType })
        }

        const total = await query.getCount()

        const sortColumnMap: Record<string, string> = {
            date: "handover.date",
            status: "handover.status",
            transactionType: "handover.transactionType",
            createdAt: "handover.createdAt",
        }
        const sortColumn = sortColumnMap[sortBy || ''] || "handover.id"
        const sortOrder = order === 'ASC' ? 'ASC' : 'DESC'

        const data = await query
            .orderBy(sortColumn, sortOrder)
            .skip(offset)
            .take(limit)
            .getMany()

        return { data, total }
    }

    async findById(id: number): Promise<Handover | null> {
        return await this.repository.findOne({
            where: { id },
            relations: [
                "items",
                "items.asset",
                "stockItems",
                "stockItems.variant",
                "stockItems.variant.inventory",
                "stockItems.branch",
                "customItems",
                "receivedBy",
                "handedOverBy",
                "createdBy",
                "parentHandover",
            ],
        })
    }

    async findPendingItemAssetIds(excludeHandoverId?: number): Promise<number[]> {
        const query = this.itemRepository.createQueryBuilder("item")
            .innerJoin("item.handover", "handover")
            .where("handover.status = :status", { status: "pending" })
            .select("item.assetId", "assetId")

        if (excludeHandoverId) {
            query.andWhere("handover.id != :excludeHandoverId", { excludeHandoverId })
        }

        const rows = await query.getRawMany<{ assetId: number }>()
        return rows.map((r) => Number(r.assetId))
    }

    async save(data: Partial<Handover>, manager?: EntityManager): Promise<Handover> {
        const repo = manager ? manager.getRepository(Handover) : this.repository
        return await repo.save(data)
    }

    async saveItem(data: Partial<HandoverItem>, manager?: EntityManager): Promise<HandoverItem> {
        const repo = manager ? manager.getRepository(HandoverItem) : this.itemRepository
        return await repo.save(data)
    }

    async saveStockItem(data: Partial<HandoverStockItem>, manager?: EntityManager): Promise<HandoverStockItem> {
        const repo = manager ? manager.getRepository(HandoverStockItem) : this.stockItemRepository
        return await repo.save(data)
    }

    async saveCustomItem(data: Partial<HandoverCustomItem>, manager?: EntityManager): Promise<HandoverCustomItem> {
        const repo = manager ? manager.getRepository(HandoverCustomItem) : this.customItemRepository
        return await repo.save(data)
    }

    async deleteItems(handoverId: number, manager?: EntityManager): Promise<void> {
        const repo = manager ? manager.getRepository(HandoverItem) : this.itemRepository
        await repo.delete({ handoverId })
    }

    async delete(id: number, manager?: EntityManager): Promise<void> {
        const repo = manager ? manager.getRepository(Handover) : this.repository
        await repo.delete(id)
    }

    merge(entity: Handover, data: Partial<Handover>): Handover {
        return this.repository.merge(entity, data)
    }
}
