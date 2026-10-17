import { describe, test, expect, beforeAll, afterAll, beforeEach, mock } from "bun:test"
import { Hono } from "hono"
import {
    initTestDatabase,
    destroyTestDatabase,
    cleanTestDatabase,
    createTestApp,
    request,
    registerAndLogin,
} from "./setup"

// ── Mock MinIO to prevent real connections ──────────────────────────────────
mock.module("../src/core/helpers/minio", () => {
    const helper = {
        upload: async () => "attachments/test-file.txt",
        getProxyUrl: (name: string) => `http://cdn.test.com/stock/${name}`,
        getPresignedUrl: async (name: string) => `http://cdn.test.com/stock/${name}`,
        delete: async () => {},
        ensureBucket: async () => {},
    }
    return { minio: helper, default: helper }
})

let app: Hono
let authHeaders: Record<string, string>
let branchA: number
let inventoryId: number
let variant1: number
let variant2: number

beforeAll(async () => {
    await initTestDatabase()
    app = createTestApp()
})

afterAll(async () => {
    await destroyTestDatabase()
})

beforeEach(async () => {
    await cleanTestDatabase()
    authHeaders = (await registerAndLogin(app)).headers

    const a = await request(app, "/api/branch", { method: "POST", headers: authHeaders, body: { code: "BR-A", name: "Branch A" } })
    branchA = a.body.data.id

    const p = await request(app, "/api/inventory", { method: "POST", headers: authHeaders, body: { name: "UTP Cable" } })
    inventoryId = p.body.data.id
    const v1 = await request(app, "/api/inventory-variant", { method: "POST", headers: authHeaders, body: { inventoryId, name: "Cat6 305m", unit: "box" } })
    variant1 = v1.body.data.id
    const v2 = await request(app, "/api/inventory-variant", { method: "POST", headers: authHeaders, body: { inventoryId, name: "Cat5e 100m" } })
    variant2 = v2.body.data.id
})

const setStock = (branchId: number, items: { variantId: number; new: number; used: number }[]) =>
    request(app, "/api/inventory/stock/entry", { method: "POST", headers: authHeaders, body: { branchId, inventoryId, items } })

let employeeCounter = 0
const createEmployee = async () => {
    employeeCounter++
    const res = await request(app, "/api/employee", {
        method: "POST", headers: authHeaders,
        body: { name: `Emp ${employeeCounter}`, employeeId: `EMP-${employeeCounter}`, jobPosition: "Staff", email: `emp${employeeCounter}@ex.com`, phone: "0800" },
    })
    return res.body.data.id as number
}

const qtyAt = async (branchId: number, variantId: number, condition: string) => {
    const res = await request(app, `/api/inventory/stock?branchId=${branchId}&variantId=${variantId}&condition=${condition}`, { headers: authHeaders })
    return res.body.data[0]?.quantity ?? 0
}

describe("Inventory Stock Out API", () => {
    test("auth required", async () => {
        expect((await request(app, "/api/inventory-stock-out")).status).toBe(401)
        expect((await request(app, "/api/inventory-stock-out", { method: "POST", body: {} })).status).toBe(401)
    })

    test("assign to employee reduces branch stock and creates one document with a returnable line item", async () => {
        await setStock(branchA, [{ variantId: variant1, new: 10, used: 0 }])
        const employeeId = await createEmployee()

        const res = await request(app, "/api/inventory-stock-out", {
            method: "POST", headers: authHeaders,
            body: { isEmployee: true, employeeId, items: [{ variantId: variant1, branchId: branchA, condition: "new", quantity: 4 }] },
        })
        expect(res.status).toBe(201)
        expect(res.body.data).toMatchObject({ isEmployee: true, employee: { id: employeeId } })
        expect(res.body.data.items.length).toBe(1)
        expect(res.body.data.items[0]).toMatchObject({ quantity: 4, quantityReturned: 0, quantityRemaining: 4, conditionAssigned: "new" })

        expect(await qtyAt(branchA, variant1, "new")).toBe(6) // 10 - 4

        const stockOuts = await request(app, `/api/inventory-stock-out?employeeId=${employeeId}&active=true`, { headers: authHeaders })
        expect(stockOuts.body.data.length).toBe(1)
        expect(stockOuts.body.data[0].items[0]).toMatchObject({ quantity: 4, quantityReturned: 0, quantityRemaining: 4 })
    })

    test("assign rejects when branch stock is insufficient (no negative)", async () => {
        await setStock(branchA, [{ variantId: variant1, new: 2, used: 0 }])
        const employeeId = await createEmployee()
        const res = await request(app, "/api/inventory-stock-out", {
            method: "POST", headers: authHeaders,
            body: { isEmployee: true, employeeId, items: [{ variantId: variant1, branchId: branchA, condition: "new", quantity: 5 }] },
        })
        expect(res.status).toBe(400)
        expect(await qtyAt(branchA, variant1, "new")).toBe(2) // unchanged
    })

    test("assign rejects employeeId when isEmployee is true but missing, or when false but provided", async () => {
        await setStock(branchA, [{ variantId: variant1, new: 10, used: 0 }])
        const employeeId = await createEmployee()

        const missing = await request(app, "/api/inventory-stock-out", {
            method: "POST", headers: authHeaders,
            body: { isEmployee: true, items: [{ variantId: variant1, branchId: branchA, condition: "new", quantity: 1 }] },
        })
        expect(missing.status).toBe(422)

        const extra = await request(app, "/api/inventory-stock-out", {
            method: "POST", headers: authHeaders,
            body: { isEmployee: false, employeeId, items: [{ variantId: variant1, branchId: branchA, condition: "new", quantity: 1 }] },
        })
        expect(extra.status).toBe(422)
    })

    test("assign with isEmployee false reduces branch stock and creates a one-way, already-resolved line item", async () => {
        await setStock(branchA, [{ variantId: variant1, new: 10, used: 0 }])

        const res = await request(app, "/api/inventory-stock-out", {
            method: "POST", headers: authHeaders,
            body: { isEmployee: false, note: "Consumed for cabling job", items: [{ variantId: variant1, branchId: branchA, condition: "new", quantity: 4 }] },
        })
        expect(res.status).toBe(201)
        expect(res.body.data.isEmployee).toBe(false)
        expect(res.body.data.employee).toBeNull()
        expect(res.body.data.items[0]).toMatchObject({ quantity: 4, quantityReturned: 4, quantityRemaining: 0 })
        expect(res.body.data.items[0].returnedDate).toBeTruthy()

        expect(await qtyAt(branchA, variant1, "new")).toBe(6) // 10 - 4

        // isEmployee: false documents always surface under active=true (never stale) despite quantityRemaining being 0.
        const stockOuts = await request(app, `/api/inventory-stock-out?branchId=${branchA}&active=true`, { headers: authHeaders })
        expect(stockOuts.body.data.some((s: any) => !s.isEmployee && s.items[0].quantity === 4)).toBe(true)
    })

    test("multi-item assign groups everything into one document, like a stock-in document", async () => {
        await setStock(branchA, [{ variantId: variant1, new: 10, used: 0 }, { variantId: variant2, new: 10, used: 0 }])
        const employeeId = await createEmployee()

        const res = await request(app, "/api/inventory-stock-out", {
            method: "POST", headers: authHeaders,
            body: {
                isEmployee: true, employeeId,
                items: [
                    { variantId: variant1, branchId: branchA, condition: "new", quantity: 2 },
                    { variantId: variant2, branchId: branchA, condition: "new", quantity: 3 },
                ],
            },
        })
        expect(res.status).toBe(201)
        expect(res.body.data.items.length).toBe(2)

        const stockOuts = await request(app, `/api/inventory-stock-out?employeeId=${employeeId}`, { headers: authHeaders })
        expect(stockOuts.body.data.length).toBe(1) // one document, not two
        expect(stockOuts.body.data[0].items.length).toBe(2)
    })

    test("return lands in USED even when assigned from NEW; branch used increases", async () => {
        await setStock(branchA, [{ variantId: variant1, new: 10, used: 0 }])
        const employeeId = await createEmployee()
        await request(app, "/api/inventory-stock-out", {
            method: "POST", headers: authHeaders,
            body: { isEmployee: true, employeeId, items: [{ variantId: variant1, branchId: branchA, condition: "new", quantity: 4 }] },
        })

        const res = await request(app, "/api/inventory-stock-out/return", {
            method: "POST", headers: authHeaders,
            body: { employeeId, items: [{ variantId: variant1, branchId: branchA, quantity: 3 }] },
        })
        expect(res.status).toBe(200)

        expect(await qtyAt(branchA, variant1, "used")).toBe(3) // returned into used
        expect(await qtyAt(branchA, variant1, "new")).toBe(6) // new not credited back

        const stockOuts = await request(app, `/api/inventory-stock-out?employeeId=${employeeId}`, { headers: authHeaders })
        expect(stockOuts.body.data[0].items[0]).toMatchObject({ quantity: 4, quantityReturned: 3, quantityRemaining: 1 })
    })

    test("return from a selected line only updates that line when the same variant has multiple conditions", async () => {
        await setStock(branchA, [{ variantId: variant1, new: 1, used: 1 }])
        const employeeId = await createEmployee()

        const assignedNew = await request(app, "/api/inventory-stock-out", {
            method: "POST", headers: authHeaders,
            body: { isEmployee: true, employeeId, items: [{ variantId: variant1, branchId: branchA, condition: "new", quantity: 1 }] },
        })
        const assignedUsed = await request(app, "/api/inventory-stock-out", {
            method: "POST", headers: authHeaders,
            body: { isEmployee: true, employeeId, items: [{ variantId: variant1, branchId: branchA, condition: "used", quantity: 1 }] },
        })
        const newItemId = assignedNew.body.data.items[0].id
        const usedItemId = assignedUsed.body.data.items[0].id

        const returned = await request(app, "/api/inventory-stock-out/return", {
            method: "POST", headers: authHeaders,
            body: { employeeId, items: [{ stockOutItemId: usedItemId, variantId: variant1, branchId: branchA, quantity: 1 }] },
        })
        expect(returned.status).toBe(200)
        expect(await qtyAt(branchA, variant1, "new")).toBe(0)
        expect(await qtyAt(branchA, variant1, "used")).toBe(1)

        const stockOuts = await request(app, `/api/inventory-stock-out?employeeId=${employeeId}`, { headers: authHeaders })
        const lines = stockOuts.body.data.flatMap((stockOut: any) => stockOut.items)
        expect(lines.find((item: any) => item.id === newItemId)).toMatchObject({ quantityRemaining: 1, quantityReturned: 0 })
        expect(lines.find((item: any) => item.id === usedItemId)).toMatchObject({ quantityRemaining: 0, quantityReturned: 1 })
    })

    test("assign with attachmentIds: the document shows the attachment", async () => {
        await setStock(branchA, [{ variantId: variant1, new: 10, used: 0 }, { variantId: variant2, new: 10, used: 0 }])
        const employeeId = await createEmployee()

        const fd = new FormData()
        fd.append("file", new File(["doc"], "evidence.txt", { type: "text/plain" }))
        const up = await app.request("/api/attachment", {
            method: "POST",
            headers: { Authorization: authHeaders.Authorization },
            body: fd,
        })
        const attId = (await up.json() as any).data.id

        const res = await request(app, "/api/inventory-stock-out", {
            method: "POST", headers: authHeaders,
            body: {
                isEmployee: true, employeeId, attachmentIds: [attId],
                items: [
                    { variantId: variant1, branchId: branchA, condition: "new", quantity: 2 },
                    { variantId: variant2, branchId: branchA, condition: "new", quantity: 3 },
                ],
            },
        })
        expect(res.status).toBe(201)
        expect(res.body.data.items.length).toBe(2)
        expect(res.body.data.attachments.length).toBe(1)
        expect(res.body.data.attachments[0].originalName).toBe("evidence.txt")
    })

    test("return cannot exceed what the employee holds", async () => {
        await setStock(branchA, [{ variantId: variant1, new: 10, used: 0 }])
        const employeeId = await createEmployee()
        await request(app, "/api/inventory-stock-out", {
            method: "POST", headers: authHeaders,
            body: { isEmployee: true, employeeId, items: [{ variantId: variant1, branchId: branchA, condition: "new", quantity: 2 }] },
        })
        const res = await request(app, "/api/inventory-stock-out/return", {
            method: "POST", headers: authHeaders,
            body: { employeeId, items: [{ variantId: variant1, branchId: branchA, quantity: 5 }] },
        })
        expect(res.status).toBe(400)
        expect(await qtyAt(branchA, variant1, "used")).toBe(0) // nothing returned
    })
})
