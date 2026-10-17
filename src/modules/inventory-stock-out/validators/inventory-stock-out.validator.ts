import { z } from "zod"
import { STOCK_CONDITIONS } from "../../../core/enums"

/**
 * Take stock out of a branch (reduces branch stock). `isEmployee: true` requires
 * `employeeId` and creates a returnable stock-out; `isEmployee: false` (consumed,
 * disposed, sold, etc.) must NOT carry an employeeId and is one-way.
 */
export const InventoryStockAssignValidator = z.object({
    isEmployee: z.boolean(),
    employeeId: z.number().optional().nullable(),
    note: z.string().trim().optional().nullable(),
    attachmentIds: z.array(z.number()).optional(),
    items: z.array(z.object({
        variantId: z.number("Variant ID is required"),
        branchId: z.number("Branch ID is required"),
        condition: z.enum(STOCK_CONDITIONS),
        quantity: z.number().int().min(1, "Quantity must be at least 1"),
    })).min(1, "At least one item is required"),
}).superRefine((data, ctx) => {
    if (data.isEmployee && !data.employeeId) {
        ctx.addIssue({ code: "custom", message: "Employee ID is required", path: ["employeeId"] })
    }
    if (!data.isEmployee && data.employeeId) {
        ctx.addIssue({ code: "custom", message: "Employee ID must not be set when isEmployee is false", path: ["employeeId"] })
    }
})
export type InventoryStockAssignValidator = z.infer<typeof InventoryStockAssignValidator>

/** Return stock an employee holds; it always comes back into `used` stock at the given branch. */
export const InventoryStockReturnValidator = z.object({
    employeeId: z.number("Employee ID is required"),
    note: z.string().trim().optional().nullable(),
    items: z.array(z.object({
        stockOutItemId: z.number().int().positive().optional(),
        variantId: z.number("Variant ID is required"),
        branchId: z.number("Branch ID is required"),
        quantity: z.number().int().min(1, "Quantity must be at least 1"),
    })).min(1, "At least one item is required"),
})
export type InventoryStockReturnValidator = z.infer<typeof InventoryStockReturnValidator>
