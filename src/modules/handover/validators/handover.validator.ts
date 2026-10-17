import { z } from "zod"
import { HANDOVER_TRANSACTION_TYPES, STOCK_CONDITIONS } from "../../../core/enums"

const TransactionTypeEnum = z.enum(HANDOVER_TRANSACTION_TYPES)

const HandoverItemValidator = z.object({
    assetId: z.number("Asset ID is required"),
    note: z.string().trim().optional().nullable(),
})

const HandoverStockItemValidator = z.object({
    variantId: z.number("Variant ID is required"),
    branchId: z.number("Branch ID is required"),
    condition: z.enum(STOCK_CONDITIONS),
    quantity: z.number().int().min(1, "Quantity must be at least 1"),
    note: z.string().trim().optional().nullable(),
})

const HandoverCustomItemValidator = z.object({
    name: z.string().trim().min(1, "Custom item name is required"),
    code: z.string().trim().optional().nullable(),
    quantity: z.number().int().min(1, "Quantity must be at least 1"),
    unit: z.string().trim().optional().nullable(),
    note: z.string().trim().optional().nullable(),
})

export const CreateHandoverValidator = z.object({
    receivedById: z.number("Received by ID is required"),
    handedOverById: z.number("Handed over by ID is required"),
    transactionType: TransactionTypeEnum,
    date: z.string().trim().min(1).optional().nullable(),
    note: z.string().trim().optional().nullable(),
    // Values for the configured custom fields, keyed by field key.
    customFields: z.record(z.string(), z.union([z.string(), z.number(), z.null()])).optional(),
    // A handover may carry asset lines, stock lines, or both.
    items: z.array(HandoverItemValidator).optional(),
    stockItems: z.array(HandoverStockItemValidator).optional(),
    customItems: z.array(HandoverCustomItemValidator).optional(),
    // Supporting documents uploaded alongside the generated signing form.
    attachmentIds: z.array(z.number()).optional(),
}).superRefine((data, ctx) => {
    if ((!data.items || data.items.length === 0) && (!data.stockItems || data.stockItems.length === 0) && (!data.customItems || data.customItems.length === 0)) {
        ctx.addIssue({ code: "custom", path: ["items"], message: "At least one asset, stock item, or custom item is required" })
    }
})

export type CreateHandoverValidator = z.infer<typeof CreateHandoverValidator>
