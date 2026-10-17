import { InventoryStockOut } from "./entities/inventory-stock-out.entity"
import { InventoryStockOutItem } from "./entities/inventory-stock-out-item.entity"
import { IInventoryStockOutRepository, InventoryStockOutFilter } from "./interfaces/inventory-stock-out.repository.interface"
import { InventoryStockAssignValidator, InventoryStockReturnValidator } from "./validators/inventory-stock-out.validator"
import { BadRequestException, NotFoundException } from "../../core/exceptions/base"
import { withTransaction } from "../../core/helpers/transaction"
import { InventoryStockService } from "../inventory-stock/inventory-stock.service"
import { InventoryVariant } from "../inventory-variant/entities/inventory-variant.entity"
import { InventoryVariantService } from "../inventory-variant/inventory-variant.service"
import { BranchService } from "../branch/branch.service"
import { EmployeeService } from "../employee/employee.service"
import { InventoryLogService } from "../inventory-log/inventory-log.service"
import { AttachmentService } from "../attachment/attachment.service"
import { Attachment } from "../attachment/entities/attachment.entity"

const ENTITY_STOCK_OUT = "InventoryStockOut"

/** Extra context passed when assign/return is driven by a handover approval. */
export interface InventoryStockOutHandoverContext {
    handoverId?: number
}

export class InventoryStockOutService {
    constructor(
        private readonly repository: IInventoryStockOutRepository,
        private readonly inventoryStockService: InventoryStockService,
        private readonly inventoryVariantService: InventoryVariantService,
        private readonly branchService: BranchService,
        private readonly employeeService: EmployeeService,
        private readonly inventoryLogService: InventoryLogService,
        private readonly attachmentService: AttachmentService
    ) {}

    async getById(id: number): Promise<{ stockOut: InventoryStockOut; attachments: Attachment[] }> {
        const stockOut = await this.repository.findById(id)
        if (!stockOut) throw new NotFoundException("Stock-out record not found")
        const attachments = await this.attachmentService.getForEntity(ENTITY_STOCK_OUT, id)
        return { stockOut, attachments }
    }

    async getStockOuts(page: number, limit: number, filters: InventoryStockOutFilter): Promise<{ data: { stockOut: InventoryStockOut; attachments: Attachment[] }[]; total: number }> {
        const { data, total } = await this.repository.findStockOuts(page, limit, filters)
        const mapped = await Promise.all(data.map(async (stockOut) => ({
            stockOut,
            attachments: await this.attachmentService.getForEntity(ENTITY_STOCK_OUT, stockOut.id),
        })))
        return { data: mapped, total }
    }

    /** Total quantity an employee still holds (not yet returned) for a variant. */
    async getRemainingHeld(employeeId: number, variantId: number): Promise<number> {
        const items = await this.repository.findActiveItems(employeeId, variantId)
        return items.reduce((sum, item) => sum + (item.quantity - item.quantityReturned), 0)
    }

    /** Best-effort pre-check that an assign can be fulfilled (validated again, with locks, on approval). */
    async assertCanAssign(items: InventoryStockAssignValidator["items"]): Promise<void> {
        for (const item of items) {
            const variant = await this.inventoryVariantService.getById(item.variantId)
            await this.branchService.getById(item.branchId)
            const available = await this.inventoryStockService.getAvailable(item.branchId, item.variantId, item.condition)
            if (available < item.quantity) {
                throw new BadRequestException(`Insufficient ${item.condition} stock for "${variant.name}" at source branch (available: ${available})`)
            }
        }
    }

    /** Best-effort pre-check that an employee holds enough to return (re-checked, with locks, on approval). */
    async assertCanReturn(employeeId: number, items: InventoryStockReturnValidator["items"]): Promise<void> {
        const perVariant = new Map<number, number>()
        for (const item of items) {
            const variant = await this.inventoryVariantService.getById(item.variantId)
            await this.branchService.getById(item.branchId)
            perVariant.set(item.variantId, (perVariant.get(item.variantId) ?? 0) + item.quantity)
            const requested = perVariant.get(item.variantId)!
            const remaining = await this.getRemainingHeld(employeeId, item.variantId)
            if (remaining < requested) {
                throw new BadRequestException(`Cannot return ${requested} of "${variant.name}" — employee only holds ${remaining}`)
            }
        }
    }

    /**
     * Take stock out of a branch: reduce the branch's on-hand quantity for each
     * item's chosen condition (never negative) and record one stock-out document
     * with a line per item. When `isEmployee: true`, the document's lines are
     * individually returnable and tracked against the employee; when
     * `isEmployee: false`, they're one-way exits (consumed, disposed, sold,
     * etc.) with no employee, marked fully resolved at creation. Reused by the
     * manual endpoint and by handover approval (always `isEmployee: true`).
     */
    async assign(data: InventoryStockAssignValidator, userId?: number, ctx: InventoryStockOutHandoverContext = {}): Promise<{ stockOut: InventoryStockOut; attachments: Attachment[] }> {
        const employee = data.isEmployee ? await this.employeeService.getById(data.employeeId!) : null
        if (employee && !employee.isActive) {
            throw new BadRequestException(`Cannot assign stock to inactive employee "${employee.name}"`)
        }
        const variants = new Map<number, InventoryVariant>()
        for (const item of data.items) {
            variants.set(item.variantId, await this.inventoryVariantService.getById(item.variantId))
            await this.branchService.getById(item.branchId)
        }

        const attachmentIds = data.attachmentIds ?? []

        const stockOutId = await withTransaction(async (manager) => {
            const now = new Date().toISOString()
            const stockOut = await this.repository.save({
                isEmployee: data.isEmployee,
                employeeId: employee?.id ?? null,
                assignedDate: now,
                assignNote: data.note ?? null,
                assignHandoverId: ctx.handoverId ?? null,
                createdByUserId: userId ?? null,
            }, manager)

            const inventoryIds = new Set<number>()
            for (const item of data.items) {
                await this.inventoryStockService.decreaseBalance(item.branchId, item.variantId, item.condition, item.quantity, manager)

                await this.repository.saveItem({
                    stockOutId: stockOut.id,
                    variantId: item.variantId,
                    branchId: item.branchId,
                    conditionAssigned: item.condition,
                    quantity: item.quantity,
                    quantityReturned: data.isEmployee ? 0 : item.quantity,
                    returnedDate: data.isEmployee ? null : now,
                }, manager)

                const variant = variants.get(item.variantId)
                if (variant?.inventoryId) inventoryIds.add(variant.inventoryId)
            }

            if (attachmentIds.length > 0) {
                await this.attachmentService.associate(attachmentIds, ENTITY_STOCK_OUT, stockOut.id, manager)
            }

            const description = employee
                ? `Stock assigned to employee "${employee.name}".`
                : "Stock taken out (non-employee)."
            for (const inventoryId of inventoryIds) {
                await this.inventoryLogService.log({
                    inventoryId,
                    module: "stock",
                    action: "assign",
                    description,
                    createdByUserId: userId ?? null,
                    newValue: data,
                }, manager)
            }

            return stockOut.id
        })

        return await this.getById(stockOutId)
    }

    /**
     * Return stock an employee holds. Returned stock always comes back as `used`
     * (per policy) at the given branch. Cannot exceed what the employee still
     * holds. A UI return may target one exact stock-out line; older callers
     * without a line ID retain oldest-first (FIFO) behavior.
     */
    async returnStock(data: InventoryStockReturnValidator, userId?: number, ctx: InventoryStockOutHandoverContext = {}): Promise<void> {
        const employee = await this.employeeService.getById(data.employeeId)
        const variants = new Map<number, InventoryVariant>()
        for (const item of data.items) {
            variants.set(item.variantId, await this.inventoryVariantService.getById(item.variantId))
            await this.branchService.getById(item.branchId)
        }

        await withTransaction(async (manager) => {
            const inventoryIds = new Set<number>()
            for (const item of data.items) {
                const activeItems = await this.repository.findActiveItems(data.employeeId, item.variantId, manager, true)
                const targetItems = item.stockOutItemId !== undefined
                    ? activeItems.filter((activeItem) => activeItem.id === item.stockOutItemId)
                    : activeItems
                if (item.stockOutItemId !== undefined && targetItems.length === 0) {
                    throw new BadRequestException(`Stock-out item ${item.stockOutItemId} is not an active holding for this employee and variant`)
                }
                if (item.stockOutItemId !== undefined && targetItems[0].branchId !== item.branchId) {
                    throw new BadRequestException(`Stock-out item ${item.stockOutItemId} does not belong to the selected branch`)
                }
                const remaining = targetItems.reduce((sum, i) => sum + (i.quantity - i.quantityReturned), 0)
                if (remaining < item.quantity) {
                    const variant = await this.inventoryVariantService.getById(item.variantId).catch(() => null)
                    throw new BadRequestException(`Cannot return ${item.quantity} of "${variant?.name || item.variantId}" — employee only holds ${remaining}`)
                }

                // Returned stock lands in `used` at the destination branch.
                await this.inventoryStockService.increaseBalance(item.branchId, item.variantId, "used", item.quantity, manager)

                // Consume the employee's lines oldest-first.
                let toReturn = item.quantity
                for (const activeItem of targetItems) {
                    if (toReturn <= 0) break
                    const avail = activeItem.quantity - activeItem.quantityReturned
                    if (avail <= 0) continue
                    const take = Math.min(avail, toReturn)
                    activeItem.quantityReturned += take
                    toReturn -= take
                    if (activeItem.quantityReturned >= activeItem.quantity) {
                        activeItem.returnedDate = new Date().toISOString()
                        activeItem.returnNote = data.note ?? activeItem.returnNote ?? null
                        activeItem.returnedByUserId = userId ?? null
                        activeItem.returnHandoverId = ctx.handoverId ?? activeItem.returnHandoverId ?? null
                    }
                    await this.repository.saveItem(activeItem, manager)
                }

                const variant = variants.get(item.variantId)
                if (variant?.inventoryId) inventoryIds.add(variant.inventoryId)
            }

            for (const inventoryId of inventoryIds) {
                await this.inventoryLogService.log({
                    inventoryId,
                    module: "stock",
                    action: "return",
                    description: `Stock returned from employee "${employee.name}".`,
                    createdByUserId: userId ?? null,
                    newValue: data,
                }, manager)
            }
        })
    }
}
