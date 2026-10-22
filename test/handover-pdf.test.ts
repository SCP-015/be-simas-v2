import { describe, test, expect } from "bun:test"
import { generateHandoverPdf, resolveEmployeeName } from "../src/core/helpers/handover-pdf"
import type { Handover } from "../src/modules/handover/entities/handover.entity"

function baseHandover(overrides: Partial<Handover> = {}): Handover {
    return {
        id: 1,
        receivedById: 1,
        receivedBy: { name: "Receiver" } as any,
        handedOverById: 2,
        handedOverBy: { name: "Giver" } as any,
        transactionType: "assign",
        note: "Note",
        customFields: null,
        status: "pending",
        items: [
            { asset: { name: "Generator", code: "AST-001" }, note: "Fine" } as any,
        ],
        stockItems: [],
        createdAt: new Date("2026-01-01"),
        updatedAt: new Date("2026-01-01"),
        ...overrides,
    } as Handover
}

describe("generateHandoverPdf", () => {
    test("generates a PDF for a normal handover", async () => {
        const bytes = await generateHandoverPdf(baseHandover())
        expect(bytes.length).toBeGreaterThan(0)
        expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe("%PDF-")
    })

    // Regression: an asset name containing a control character (e.g. stray bytes from a bad
    // import/sync) used to crash pdf-lib with "WinAnsi cannot encode ..." since neither
    // wrapText nor the direct-drawn fields (labels, signature names) sanitized their input.
    test("generates an assign PDF with custom items", async () => {
        const bytes = await generateHandoverPdf(baseHandover({
            items: [],
            customItems: [{ name: "ID Card", code: "CARD-001", quantity: 1, unit: "Pcs", note: "For onboarding" }] as any,
        }))
        expect(bytes.length).toBeGreaterThan(0)
        expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe("%PDF-")
    })

    test("does not throw when free-text fields contain control characters", async () => {
        const handover = baseHandover({
            note: "Note with control char  inside",
            handedOverBy: { name: "Giver  Name" } as any,
            receivedBy: { name: "Receiver  Name" } as any,
            items: [
                { asset: { name: "Generator  Model", code: "AST-001" }, note: "Fine " } as any,
            ],
            customFields: [{ key: "pic", label: "PIC ", type: "text", value: "Someone " }],
        })

        const bytes = await generateHandoverPdf(handover)
        expect(bytes.length).toBeGreaterThan(0)
        expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe("%PDF-")
    })
})

describe("resolveEmployeeName", () => {
    test("assign (Penetapan) uses the receiving employee's name", () => {
        const name = resolveEmployeeName({
            transactionType: "assign",
            receivedBy: { name: "Receiver" } as any,
            handedOverBy: { name: "Giver" } as any,
        })
        expect(name).toBe("Receiver")
    })

    test("return (Pengembalian) uses the handing-over employee's name", () => {
        const name = resolveEmployeeName({
            transactionType: "return",
            receivedBy: { name: "Receiver" } as any,
            handedOverBy: { name: "Giver" } as any,
        })
        expect(name).toBe("Giver")
    })

    test("falls back to '-' when the relevant employee is missing", () => {
        expect(resolveEmployeeName({ transactionType: "assign", receivedBy: null as any, handedOverBy: null as any })).toBe("-")
        expect(resolveEmployeeName({ transactionType: "return", receivedBy: null as any, handedOverBy: null as any })).toBe("-")
    })
})
