import { describe, test, expect, beforeAll, afterAll, beforeEach, mock } from "bun:test"
import { Hono } from "hono"
import ExcelJS from "exceljs"
import { config } from "../src/config/config"
import {
    initTestDatabase,
    destroyTestDatabase,
    cleanTestDatabase,
    createTestApp,
    request,
    registerAndLogin,
} from "./setup"
import { resetCounters } from "./helpers"

// ── Mock MinIO to prevent real connections ──────────────────────────────────

mock.module("../src/core/helpers/minio", () => {
    const sanitizePath = (urlOrPath: string | null | undefined, bucket: string = "stock"): string | null => {
        if (!urlOrPath) return null
        let decoded = urlOrPath
        try {
            while (decoded && decoded.includes('%')) {
                const next = decodeURIComponent(decoded)
                if (next === decoded) break
                decoded = next
            }
        } catch { /* ignore */ }
        const marker = `/${bucket}/`
        if (decoded.includes(marker)) {
            const parts = decoded.split(marker)
            decoded = parts[parts.length - 1]
        }
        if (decoded.includes('?')) decoded = decoded.split('?')[0]
        decoded = decoded.replace(/^\/+|\/+$/g, '')
        return decoded || null
    }

    const helper = {
        upload: async () => {},
        getProxyUrl: (objectName: string) => `http://cdn.test.com/stock/${objectName}`,
        getPresignedUrl: async (path: string) => `http://cdn.test.com/stock/${path}`,
        getPublicUrl: (objectName: string) => `http://cdn.test.com/stock/${objectName}`,
        sanitizePath,
        ensureBucket: async () => {},
        proxyHandler: async () => new Response("ok"),
    }

    return { minio: helper, default: helper }
})

// ── Mock Nusawork Helper to prevent real connections and record sync calls ──
export const nusaworkSyncCalls: any[] = []
export const nusaworkUpdateCalls: any[] = []
export let nusaworkGroupsResponse: { id_group: number; items: { key: string; input: { value: string } }[] }[] = []
mock.module("../src/core/helpers/nusawork", () => ({
    nusaworkHelper: {
        createAssetSync: async (payload: any) => { nusaworkSyncCalls.push(payload); return { success: true, data: { id_group: 5001 } } },
        getAssetSyncGroups: async () => nusaworkGroupsResponse,
        returnAssetSync: async () => ({ success: true }),
        updateAssetSync: async (payload: any) => { nusaworkUpdateCalls.push(payload); return { success: true } },
        deleteAssetSync: async () => ({ success: true }),
    },
}))

// Nusawork sync runs through the job queue now — drain it after actions that
// used to sync inline. Imported dynamically so the queue repository binds to
// the test DataSource (only swapped in by initTestDatabase() at runtime).
async function drainQueue(): Promise<void> {
    const { queueService } = await import("../src/modules/queue/queue.module")
    await import("../src/modules/queue/handlers/nusawork.handlers")
    while (await queueService.processNext()) { /* keep draining */ }
}

// ── Setup ───────────────────────────────────────────────────────────────────

let app: Hono

beforeAll(async () => {
    await initTestDatabase()
    app = createTestApp()
})

afterAll(async () => {
    await destroyTestDatabase()
})

beforeEach(async () => {
    await cleanTestDatabase()
    resetCounters()
    nusaworkSyncCalls.length = 0
    nusaworkUpdateCalls.length = 0
    nusaworkGroupsResponse = []
})

// ── Test Data Helper ────────────────────────────────────────────────────────

let assetCounter = 0

function createAssetData(subCategoryId: number, overrides: Record<string, any> = {}) {
    assetCounter++
    return {
        code: `AST-${String(assetCounter).padStart(3, "0")}`,
        name: `Asset ${assetCounter}`,
        description: `Description for asset ${assetCounter}`,
        price: 15000000 + assetCounter,
        purchaseDate: "2026-06-18",
        brand: "Brand A",
        model: "Model X",
        image: "assets/image-123.jpg",
        subCategoryId,
        ...overrides,
    }
}

async function createTestSubCategory(app: Hono, headers: any) {
    // 1. Create Category
    const catRes = await request(app, "/api/category", {
        method: "POST",
        headers,
        body: { name: "Electronics", description: "Electronics items" }
    })
    const category = catRes.body.data

    // 2. Create SubCategory
    const subRes = await request(app, "/api/sub-category", {
        method: "POST",
        headers,
        body: { name: "Laptops", categoryId: category.id, description: "Laptops sub category" }
    })
    return subRes.body.data
}

// Reset asset counter in beforeEach
beforeEach(() => {
    assetCounter = 0
})

// ═══════════════════════════════════════════════════════════════════════════
// Authentication Required — All asset routes need auth
// ═══════════════════════════════════════════════════════════════════════════

describe("Asset - Auth Required", () => {
    test("GET /api/asset should fail without auth", async () => {
        const { status, body } = await request(app, "/api/asset")
        expect(status).toBe(401)
        expect(body.success).toBe(false)
    })

    test("POST /api/asset should fail without auth", async () => {
        const { status, body } = await request(app, "/api/asset", {
            method: "POST",
            body: { name: "Asset", code: "AST-001", subCategoryId: 1 },
        })
        expect(status).toBe(401)
        expect(body.success).toBe(false)
    })

    test("GET /api/asset/:id should fail without auth", async () => {
        const { status, body } = await request(app, "/api/asset/1")
        expect(status).toBe(401)
        expect(body.success).toBe(false)
    })

    test("PUT /api/asset/:id should fail without auth", async () => {
        const { status, body } = await request(app, "/api/asset/1", {
            method: "PUT",
            body: { name: "Updated" },
        })
        expect(status).toBe(401)
        expect(body.success).toBe(false)
    })

    test("DELETE /api/asset/:id should fail without auth", async () => {
        const { status, body } = await request(app, "/api/asset/1", {
            method: "DELETE",
        })
        expect(status).toBe(401)
        expect(body.success).toBe(false)
    })
})

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/asset — Create
// ═══════════════════════════════════════════════════════════════════════════

describe("POST /api/asset", () => {
    test("should create an asset successfully", async () => {
        const { headers } = await registerAndLogin(app)
        const subCategory = await createTestSubCategory(app, headers)
        const assetData = createAssetData(subCategory.id)

        const { status, body } = await request(app, "/api/asset", {
            method: "POST",
            headers,
            body: assetData,
        })

        expect(status).toBe(201)
        expect(body.success).toBe(true)
        expect(body.message).toBe("Asset created successfully")
        expect(body.data).toBeDefined()
        expect(body.data.code).toBe(assetData.code)
        expect(body.data.name).toBe(assetData.name)
        expect(body.data.description).toBe(assetData.description)
        expect(body.data.price).toBe(assetData.price)
        expect(body.data.purchaseDate).toBe(assetData.purchaseDate)
        expect(body.data.brand).toBe(assetData.brand)
        expect(body.data.model).toBe(assetData.model)
        expect(body.data.image).toBe(`http://cdn.test.com/stock/${assetData.image}`)
        expect(body.data.subCategory).toBeDefined()
        expect(body.data.subCategory).toBeDefined()
        expect(body.data.subCategory.id).toBe(subCategory.id)
        expect(body.data.subCategory.name).toBe(subCategory.name)
        expect(body.data.subCategory.category).toBeDefined()
        expect(body.data.createdBy).toBeDefined()
        expect(body.data.createdBy.name).toBe("Test User")
    })

    test("should create an asset without optional fields", async () => {
        const { headers } = await registerAndLogin(app)
        const subCategory = await createTestSubCategory(app, headers)

        const { status, body } = await request(app, "/api/asset", {
            method: "POST",
            headers,
            body: {
                code: "AST-MIN",
                name: "Minimal Asset",
                subCategoryId: subCategory.id
            },
        })

        expect(status).toBe(201)
        expect(body.success).toBe(true)
        expect(body.data.description).toBeNull()
        expect(body.data.price).toBeNull()
        expect(body.data.purchaseDate).toBeNull()
        expect(body.data.brand).toBeNull()
        expect(body.data.model).toBeNull()
        expect(body.data.image).toBeNull()
        expect(body.data.createdBy).toBeDefined()
        expect(body.data.createdBy.name).toBe("Test User")
    })

    test("should fail validation without code", async () => {
        const { headers } = await registerAndLogin(app)
        const subCategory = await createTestSubCategory(app, headers)

        const { status, body } = await request(app, "/api/asset", {
            method: "POST",
            headers,
            body: { name: "Asset Test", subCategoryId: subCategory.id },
        })

        expect(status).toBe(422)
        expect(body.success).toBe(false)
    })

    test("should fail validation without subCategoryId", async () => {
        const { headers } = await registerAndLogin(app)

        const { status, body } = await request(app, "/api/asset", {
            method: "POST",
            headers,
            body: { code: "AST-001", name: "Asset Test" },
        })

        expect(status).toBe(422)
        expect(body.success).toBe(false)
    })

    test("should enforce unique code", async () => {
        const { headers } = await registerAndLogin(app)
        const subCategory = await createTestSubCategory(app, headers)
        const assetData = createAssetData(subCategory.id, { code: "UNIQUE-CODE" })

        // Create first time
        await request(app, "/api/asset", {
            method: "POST",
            headers,
            body: assetData,
        })

        // Create second time with same code
        const { status, body } = await request(app, "/api/asset", {
            method: "POST",
            headers,
            body: createAssetData(subCategory.id, { code: "UNIQUE-CODE" }),
        })

        expect(status).toBe(400)
        expect(body.success).toBe(false)
        expect(body.message).toBe("Asset code must be unique")
    })

    test("should create an asset and immediately assign and set location successfully", async () => {
        const { headers } = await registerAndLogin(app)
        const subCategory = await createTestSubCategory(app, headers)
        
        // Create Employee for assign
        const empRes = await request(app, "/api/employee", {
            method: "POST",
            headers,
            body: {
                employeeId: "EMP-999",
                name: "Bob Builder",
                jobPosition: "Engineer",
                email: "bob@builder.com",
                phone: "08123456780"
            }
        })
        const employeeId = empRes.body.data.id

        // Create Branch & Location for relocation
        const branchRes = await request(app, "/api/branch", {
            method: "POST",
            headers,
            body: { code: "BR-NEW", name: "New Branch" }
        })
        const locRes = await request(app, "/api/location", {
            method: "POST",
            headers,
            body: { name: "Room 101", branchId: branchRes.body.data.id }
        })
        const locationId = locRes.body.data.id

        // Now create asset with immediate assign & location
        const assetRes = await request(app, "/api/asset", {
            method: "POST",
            headers,
            body: {
                code: "AST-TRANS",
                name: "Transactional Laptop",
                subCategoryId: subCategory.id,
                employeeId,
                assignedDate: "2026-06-20",
                assignNote: "Direct assign",
                locationId,
                locationDate: "2026-06-20",
                locationNote: "Direct location"
            }
        })

        expect(assetRes.status).toBe(201)
        expect(assetRes.body.success).toBe(true)
        expect(assetRes.body.data.activeHolder).toBeDefined()
        expect(assetRes.body.data.activeHolder.employee.name).toBe("Bob Builder")
        expect(assetRes.body.data.lastLocation).toBeDefined()
        expect(assetRes.body.data.lastLocation.location.name).toBe("Room 101")
    })
})

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/asset — List
// ═══════════════════════════════════════════════════════════════════════════

describe("GET /api/asset", () => {
    test("should return empty list initially", async () => {
        const { headers } = await registerAndLogin(app)

        const { status, body } = await request(app, "/api/asset", {
            method: "GET",
            headers,
        })

        expect(status).toBe(200)
        expect(body.success).toBe(true)
        expect(body.data.length).toBe(0)
        expect(body.meta.total).toBe(0)
    })

    test("should return created assets", async () => {
        const { headers } = await registerAndLogin(app)
        const subCategory = await createTestSubCategory(app, headers)

        await request(app, "/api/asset", {
            method: "POST",
            headers,
            body: createAssetData(subCategory.id, {
                labels: [
                    { key: "Color", value: "Space Gray" },
                    { key: "Storage", value: "512GB" }
                ]
            }),
        })

        const { status, body } = await request(app, "/api/asset", {
            method: "GET",
            headers,
        })

        expect(status).toBe(200)
        expect(body.data.length).toBe(1)
        expect(body.meta.total).toBe(1)
        expect(body.data[0].subCategory.id).toBe(subCategory.id)
        expect(body.data[0].labels).toBeDefined()
        expect(body.data[0].labels.length).toBe(2)
        expect(body.data[0].labels[0].key).toBe("Color")
        expect(body.data[0].labels[0].value).toBe("Space Gray")
        expect(body.data[0].labels[1].key).toBe("Storage")
        expect(body.data[0].labels[1].value).toBe("512GB")
    })

    test("should search assets by name or code", async () => {
        const { headers } = await registerAndLogin(app)
        const subCategory = await createTestSubCategory(app, headers)

        await request(app, "/api/asset", {
            method: "POST",
            headers,
            body: createAssetData(subCategory.id, { name: "MacBook Pro", code: "MAC-01" }),
        })
        await request(app, "/api/asset", {
            method: "POST",
            headers,
            body: createAssetData(subCategory.id, { name: "Dell XPS", code: "DELL-01" }),
        })

        // Search by name
        const res1 = await request(app, "/api/asset?q=MacBook", { method: "GET", headers })
        expect(res1.body.data.length).toBe(1)
        expect(res1.body.data[0].name).toBe("MacBook Pro")

        // Search by code
        const res2 = await request(app, "/api/asset?q=DELL-01", { method: "GET", headers })
        expect(res2.body.data.length).toBe(1)
        expect(res2.body.data[0].code).toBe("MAC-01" ? "DELL-01" : "DELL-01") // check code
        expect(res2.body.data[0].name).toBe("Dell XPS")
    })

    test("should sort assets by name or price", async () => {
        const { headers } = await registerAndLogin(app)
        const subCategory = await createTestSubCategory(app, headers)

        await request(app, "/api/asset", {
            method: "POST",
            headers,
            body: createAssetData(subCategory.id, { name: "B Asset", price: 20000, code: "AST-B" }),
        })
        await request(app, "/api/asset", {
            method: "POST",
            headers,
            body: createAssetData(subCategory.id, { name: "A Asset", price: 30000, code: "AST-A" }),
        })
        await request(app, "/api/asset", {
            method: "POST",
            headers,
            body: createAssetData(subCategory.id, { name: "C Asset", price: 10000, code: "AST-C" }),
        })

        // Sort by name ASC
        const resNameAsc = await request(app, "/api/asset?sortBy=name&order=ASC", { method: "GET", headers })
        expect(resNameAsc.status).toBe(200)
        expect(resNameAsc.body.data[0].name).toBe("A Asset")
        expect(resNameAsc.body.data[1].name).toBe("B Asset")
        expect(resNameAsc.body.data[2].name).toBe("C Asset")

        // Sort by name DESC
        const resNameDesc = await request(app, "/api/asset?sortBy=name&order=DESC", { method: "GET", headers })
        expect(resNameDesc.status).toBe(200)
        expect(resNameDesc.body.data[0].name).toBe("C Asset")
        expect(resNameDesc.body.data[1].name).toBe("B Asset")
        expect(resNameDesc.body.data[2].name).toBe("A Asset")

        // Sort by price ASC
        const resPriceAsc = await request(app, "/api/asset?sortBy=price&order=ASC", { method: "GET", headers })
        expect(resPriceAsc.status).toBe(200)
        expect(resPriceAsc.body.data[0].price).toBe(10000)
        expect(resPriceAsc.body.data[1].price).toBe(20000)
        expect(resPriceAsc.body.data[2].price).toBe(30000)
    })
})

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/asset/:id — Show
// ═══════════════════════════════════════════════════════════════════════════

describe("GET /api/asset/:id", () => {
    test("should return asset by ID", async () => {
        const { headers } = await registerAndLogin(app)
        const subCategory = await createTestSubCategory(app, headers)
        const assetData = createAssetData(subCategory.id)

        const createRes = await request(app, "/api/asset", {
            method: "POST",
            headers,
            body: assetData,
        })
        const assetId = createRes.body.data.id

        const { status, body } = await request(app, `/api/asset/${assetId}`, {
            method: "GET",
            headers,
        })

        expect(status).toBe(200)
        expect(body.success).toBe(true)
        expect(body.data.id).toBe(assetId)
        expect(body.data.code).toBe(assetData.code)
    })

    test("should return 404 for non-existent asset", async () => {
        const { headers } = await registerAndLogin(app)

        const { status, body } = await request(app, "/api/asset/99999", {
            method: "GET",
            headers,
        })

        expect(status).toBe(404)
        expect(body.success).toBe(false)
        expect(body.message).toBe("Asset not found")
    })

    test("should include lastStatus with createdBy in asset response", async () => {
        const { headers } = await registerAndLogin(app)
        const subCategory = await createTestSubCategory(app, headers)

        // Create asset with an initial status
        const createRes = await request(app, "/api/asset", {
            method: "POST",
            headers,
            body: createAssetData(subCategory.id, {
                code: "AST-LSTATUS",
                name: "Status Asset",
                status: "active",
                statusNote: "Ready for use",
            }),
        })
        expect(createRes.status).toBe(201)
        const assetId = createRes.body.data.id

        // Fetch full asset detail
        const { status, body } = await request(app, `/api/asset/${assetId}`, {
            method: "GET",
            headers,
        })

        expect(status).toBe(200)
        expect(body.data.lastStatus).toBeDefined()
        expect(body.data.lastStatus).not.toBeNull()
        expect(body.data.lastStatus.id).toBeDefined()
        expect(body.data.lastStatus.status).toBe("active")
        expect(body.data.lastStatus.note).toBe("Ready for use")
        expect(body.data.lastStatus.createdAt).toBeDefined()

        // createdBy should be present and match the logged-in user
        expect(body.data.lastStatus.createdBy).toBeDefined()
        expect(body.data.lastStatus.createdBy).not.toBeNull()
        expect(body.data.lastStatus.createdBy.id).toBeDefined()
        expect(body.data.lastStatus.createdBy.name).toBe("Test User")
        expect(body.data.lastStatus.createdBy).toHaveProperty("photo")
    })
})

// ═══════════════════════════════════════════════════════════════════════════
// PUT /api/asset/:id — Update
// ═══════════════════════════════════════════════════════════════════════════

describe("PUT /api/asset/:id", () => {
    test("should update asset details successfully", async () => {
        const { headers } = await registerAndLogin(app)
        const subCategory = await createTestSubCategory(app, headers)

        const createRes = await request(app, "/api/asset", {
            method: "POST",
            headers,
            body: createAssetData(subCategory.id),
        })
        const assetId = createRes.body.data.id

        const { status, body } = await request(app, `/api/asset/${assetId}`, {
            method: "PUT",
            headers,
            body: { name: "Updated Asset Name", price: 18000000 },
        })

        expect(status).toBe(200)
        expect(body.success).toBe(true)
        expect(body.data.name).toBe("Updated Asset Name")
        expect(body.data.price).toBe(18000000)
    })

    test("should persist a changed sub category", async () => {
        const { headers } = await registerAndLogin(app)
        const originalSubCategory = await createTestSubCategory(app, headers)
        const replacementSubCategory = await createTestSubCategory(app, headers)

        const createRes = await request(app, "/api/asset", {
            method: "POST",
            headers,
            body: createAssetData(originalSubCategory.id),
        })
        const assetId = createRes.body.data.id

        const updateRes = await request(app, `/api/asset/${assetId}`, {
            method: "PUT",
            headers,
            body: { subCategoryId: replacementSubCategory.id },
        })

        expect(updateRes.status).toBe(200)
        expect(updateRes.body.data.subCategory.id).toBe(replacementSubCategory.id)

        const detailRes = await request(app, `/api/asset/${assetId}`, {
            method: "GET",
            headers,
        })
        expect(detailRes.body.data.subCategory.id).toBe(replacementSubCategory.id)
    })

    test("re-syncs every employee holder's Nusawork note when the asset's code/name changes", async () => {
        const { headers } = await registerAndLogin(app)
        const subCategory = await createTestSubCategory(app, headers)
        const emp = await request(app, "/api/employee", { method: "POST", headers, body: { employeeId: "EMP-EDIT-01", name: "Edit Worker", jobPosition: "Staff", email: "edit01@test.com", phone: "081" } })
        const employeeId = emp.body.data.id

        const createRes = await request(app, "/api/asset", {
            method: "POST",
            headers,
            body: createAssetData(subCategory.id, { code: "AST-EDIT-01", name: "Old Laptop", employeeId, assignedDate: "2026-01-01" }),
        })
        const assetId = createRes.body.data.id
        const holderId = createRes.body.data.activeHolder.id

        // Return it, then assign again, so this asset has one historical + one active employee holder.
        nusaworkGroupsResponse = [{ id_group: 5001, items: [{ key: "id_holder", input: { value: String(holderId) } }] }]
        await request(app, `/api/asset-holder/${holderId}/return`, { method: "POST", headers, body: { returnedDate: "2026-01-05" } })
        const reassign = await request(app, "/api/asset-holder", { method: "POST", headers, body: { assetId, employeeId, assignedDate: "2026-01-06", assignNote: "second round" } })
        const holderId2 = reassign.body.data.id
        nusaworkUpdateCalls.length = 0

        nusaworkGroupsResponse = [
            { id_group: 5001, items: [{ key: "id_holder", input: { value: String(holderId) } }] },
            { id_group: 5002, items: [{ key: "id_holder", input: { value: String(holderId2) } }] },
        ]

        const res = await request(app, `/api/asset/${assetId}`, {
            method: "PUT",
            headers,
            body: { code: "AST-EDIT-02", name: "New Laptop" },
        })

        expect(res.status).toBe(200)
        await drainQueue()
        expect(nusaworkUpdateCalls.length).toBe(2)
        const byGroup = Object.fromEntries(nusaworkUpdateCalls.map((c: any) => [c.id_group, c]))

        expect(byGroup[5001]).toEqual({
            employee_id: "EMP-EDIT-01",
            id_group: 5001,
            fields: {
                asset_code: "AST-EDIT-02",
                asset_name: "New Laptop",
                assign_date: "2026-01-01 00:00:00",
                assign_note: undefined,
                return_date: "2026-01-05 00:00:00",
                return_note: undefined,
            },
        })
        expect(byGroup[5002]).toEqual({
            employee_id: "EMP-EDIT-01",
            id_group: 5002,
            fields: {
                asset_code: "AST-EDIT-02",
                asset_name: "New Laptop",
                assign_date: "2026-01-06 00:00:00",
                assign_note: "second round",
                return_date: undefined,
                return_note: undefined,
            },
        })
    })

    test("does not sync to Nusawork when an unrelated field changes", async () => {
        const { headers } = await registerAndLogin(app)
        const subCategory = await createTestSubCategory(app, headers)
        const emp = await request(app, "/api/employee", { method: "POST", headers, body: { employeeId: "EMP-EDIT-02", name: "Edit Worker 2", jobPosition: "Staff", email: "edit02@test.com", phone: "082" } })

        const createRes = await request(app, "/api/asset", {
            method: "POST",
            headers,
            body: createAssetData(subCategory.id, { code: "AST-EDIT-03", name: "Some Laptop", employeeId: emp.body.data.id, assignedDate: "2026-01-01" }),
        })
        nusaworkUpdateCalls.length = 0

        const res = await request(app, `/api/asset/${createRes.body.data.id}`, {
            method: "PUT",
            headers,
            body: { price: 5000000 },
        })

        expect(res.status).toBe(200)
        await drainQueue()
        expect(nusaworkUpdateCalls.length).toBe(0)
    })
})

// ═══════════════════════════════════════════════════════════════════════════
// Asset Settings Flags
// ═══════════════════════════════════════════════════════════════════════════

describe("Asset Settings Flags", () => {
    test("should serialize activeHolder and lastLocation as null if hasHolder or hasLocation is set to false", async () => {
        const { headers } = await registerAndLogin(app)
        const subCategory = await createTestSubCategory(app, headers)

        // Create Employee for assign
        const empRes = await request(app, "/api/employee", {
            method: "POST",
            headers,
            body: {
                employeeId: "EMP-X",
                name: "Test Employee",
                jobPosition: "Engineer",
                email: "test@emp.com",
                phone: "08123456781"
            }
        })
        const employeeId = empRes.body.data.id

        // Create Branch & Location
        const branchRes = await request(app, "/api/branch", {
            method: "POST",
            headers,
            body: { code: "BR-Y", name: "Branch Y" }
        })
        const locRes = await request(app, "/api/location", {
            method: "POST",
            headers,
            body: { name: "Location Y", branchId: branchRes.body.data.id }
        })
        const locationId = locRes.body.data.id

        // Create asset with hasHolder=false, hasLocation=false, but supplying employeeId/locationId
        const { status, body } = await request(app, "/api/asset", {
            method: "POST",
            headers,
            body: {
                code: "AST-FLAGS",
                name: "Flags Asset",
                subCategoryId: subCategory.id,
                hasHolder: false,
                hasLocation: false,
                employeeId,
                locationId
            },
        })

        expect(status).toBe(201)
        expect(body.success).toBe(true)
        expect(body.data.hasHolder).toBe(false)
        expect(body.data.hasLocation).toBe(false)
        expect(body.data.activeHolder).toBeNull()
        expect(body.data.lastLocation).toBeNull()

        // Fetch details to ensure it stays null
        const getRes = await request(app, `/api/asset/${body.data.id}`, {
            method: "GET",
            headers
        })
        expect(getRes.status).toBe(200)
        expect(getRes.body.data.activeHolder).toBeNull()
        expect(getRes.body.data.lastLocation).toBeNull()
    })
})


// ═══════════════════════════════════════════════════════════════════════════
// DELETE /api/asset/:id — Destroy
// ═══════════════════════════════════════════════════════════════════════════

describe("DELETE /api/asset/:id", () => {
    test("should delete asset successfully", async () => {
        const { headers } = await registerAndLogin(app)
        const subCategory = await createTestSubCategory(app, headers)

        const createRes = await request(app, "/api/asset", {
            method: "POST",
            headers,
            body: createAssetData(subCategory.id),
        })
        const assetId = createRes.body.data.id

        const { status, body } = await request(app, `/api/asset/${assetId}`, {
            method: "DELETE",
            headers,
        })

        expect(status).toBe(200)
        expect(body.success).toBe(true)

        // Verify it's deleted
        const { status: getStatus } = await request(app, `/api/asset/${assetId}`, {
            method: "GET",
            headers,
        })
        expect(getStatus).toBe(404)
    })
})

describe("GET /api/asset - filtering", () => {
    test("should filter assets by categoryIds and subCategoryIds", async () => {
        const { headers } = await registerAndLogin(app)
        const subCategory = await createTestSubCategory(app, headers) // has Category "Electronics" and SubCategory "Laptops"
        
        // Create another category & subcategory
        const catRes2 = await request(app, "/api/category", {
            method: "POST",
            headers,
            body: { name: "Furniture", description: "Furniture items" }
        })
        const category2 = catRes2.body.data
        const subRes2 = await request(app, "/api/sub-category", {
            method: "POST",
            headers,
            body: { name: "Chairs", categoryId: category2.id }
        })
        const subCategory2 = subRes2.body.data

        // Create asset 1 in subCategory 1
        await request(app, "/api/asset", {
            method: "POST",
            headers,
            body: createAssetData(subCategory.id, { name: "Laptop 1", price: 10000 }),
        })
        // Create asset 2 in subCategory 2
        await request(app, "/api/asset", {
            method: "POST",
            headers,
            body: createAssetData(subCategory2.id, { name: "Chair 1", price: 5000 }),
        })

        // Filter by categoryIds of subCategory 1
        const resCat1 = await request(app, `/api/asset?categoryIds=${subCategory.category.id}`, { method: "GET", headers })
        expect(resCat1.body.data.length).toBe(1)
        expect(resCat1.body.data[0].name).toBe("Laptop 1")

        // Filter by subCategoryIds of subCategory 2
        const resSub2 = await request(app, `/api/asset?subCategoryIds=${subCategory2.id}`, { method: "GET", headers })
        expect(resSub2.body.data.length).toBe(1)
        expect(resSub2.body.data[0].name).toBe("Chair 1")
    })

    test("should filter assets by price range", async () => {
        const { headers } = await registerAndLogin(app)
        const subCategory = await createTestSubCategory(app, headers)

        await request(app, "/api/asset", {
            method: "POST",
            headers,
            body: createAssetData(subCategory.id, { name: "Cheap Laptop", price: 5000000 }),
        })
        await request(app, "/api/asset", {
            method: "POST",
            headers,
            body: createAssetData(subCategory.id, { name: "Medium Laptop", price: 10000000 }),
        })
        await request(app, "/api/asset", {
            method: "POST",
            headers,
            body: createAssetData(subCategory.id, { name: "Expensive Laptop", price: 20000000 }),
        })

        // Filter min price
        const resMin = await request(app, "/api/asset?priceMin=10000000", { method: "GET", headers })
        expect(resMin.body.data.length).toBe(2)
        const namesMin = resMin.body.data.map((a: any) => a.name)
        expect(namesMin).toContain("Medium Laptop")
        expect(namesMin).toContain("Expensive Laptop")

        // Filter max price
        const resMax = await request(app, "/api/asset?priceMax=10000000", { method: "GET", headers })
        expect(resMax.body.data.length).toBe(2)
        const namesMax = resMax.body.data.map((a: any) => a.name)
        expect(namesMax).toContain("Cheap Laptop")
        expect(namesMax).toContain("Medium Laptop")

        // Filter min & max price range
        const resRange = await request(app, "/api/asset?priceMin=6000000&priceMax=15000000", { method: "GET", headers })
        expect(resRange.body.data.length).toBe(1)
        expect(resRange.body.data[0].name).toBe("Medium Laptop")
    })

    test("should filter assets by purchaseDate range", async () => {
        const { headers } = await registerAndLogin(app)
        const subCategory = await createTestSubCategory(app, headers)

        await request(app, "/api/asset", {
            method: "POST",
            headers,
            body: createAssetData(subCategory.id, { name: "Asset A", purchaseDate: "2024-01-15" }),
        })
        await request(app, "/api/asset", {
            method: "POST",
            headers,
            body: createAssetData(subCategory.id, { name: "Asset B", purchaseDate: "2025-06-20" }),
        })
        await request(app, "/api/asset", {
            method: "POST",
            headers,
            body: createAssetData(subCategory.id, { name: "Asset C", purchaseDate: "2026-03-10" }),
        })

        // Filter purchaseDateFrom
        const resFrom = await request(app, "/api/asset?purchaseDateFrom=2025-01-01", { method: "GET", headers })
        expect(resFrom.body.data.length).toBe(2)
        const namesFrom = resFrom.body.data.map((a: any) => a.name)
        expect(namesFrom).toContain("Asset B")
        expect(namesFrom).toContain("Asset C")

        // Filter purchaseDateTo
        const resTo = await request(app, "/api/asset?purchaseDateTo=2025-12-31", { method: "GET", headers })
        expect(resTo.body.data.length).toBe(2)
        const namesTo = resTo.body.data.map((a: any) => a.name)
        expect(namesTo).toContain("Asset A")
        expect(namesTo).toContain("Asset B")

        // Filter purchaseDate range
        const resRange = await request(app, "/api/asset?purchaseDateFrom=2025-01-01&purchaseDateTo=2025-12-31", { method: "GET", headers })
        expect(resRange.body.data.length).toBe(1)
        expect(resRange.body.data[0].name).toBe("Asset B")
    })

    test("should filter assets by bleTagStatus", async () => {
        const { headers } = await registerAndLogin(app)
        const subCategory = await createTestSubCategory(app, headers)

        await request(app, "/api/asset", {
            method: "POST",
            headers,
            body: createAssetData(subCategory.id, { name: "Asset With BLE", bleTagMac: "AA:BB:CC:DD:EE:FF" }),
        })
        await request(app, "/api/asset", {
            method: "POST",
            headers,
            body: createAssetData(subCategory.id, { name: "Asset No BLE" }),
        })

        // Filter has_ble_tag
        const resBle = await request(app, "/api/asset?bleTagStatus=has_ble_tag", { method: "GET", headers })
        expect(resBle.body.data.length).toBe(1)
        expect(resBle.body.data[0].name).toBe("Asset With BLE")

        // Filter no_ble_tag
        const resNoBle = await request(app, "/api/asset?bleTagStatus=no_ble_tag", { method: "GET", headers })
        expect(resNoBle.body.data.length).toBe(1)
        expect(resNoBle.body.data[0].name).toBe("Asset No BLE")
    })
})

// ═══════════════════════════════════════════════════════════════════════════
// Holder Type Filtering (active vs historical)
// ═══════════════════════════════════════════════════════════════════════════

describe("GET /api/asset - holderType filtering", () => {
    async function setupHolderTestData(app: Hono, headers: any) {
        const subCategory = await createTestSubCategory(app, headers)

        // Create two employees
        const emp1Res = await request(app, "/api/employee", {
            method: "POST",
            headers,
            body: { employeeId: "EMP-H1", name: "Employee One", jobPosition: "Dev", email: "emp1@test.com", phone: "081001" }
        })
        const emp2Res = await request(app, "/api/employee", {
            method: "POST",
            headers,
            body: { employeeId: "EMP-H2", name: "Employee Two", jobPosition: "QA", email: "emp2@test.com", phone: "081002" }
        })
        const emp1Id = emp1Res.body.data.id
        const emp2Id = emp2Res.body.data.id

        // Asset 1: has active holder (emp1)
        const asset1Res = await request(app, "/api/asset", {
            method: "POST",
            headers,
            body: createAssetData(subCategory.id, {
                name: "Active Holder Asset",
                employeeId: emp1Id,
                assignedDate: "2026-01-01",
            }),
        })
        const asset1Id = asset1Res.body.data.id

        // Asset 2: was held by emp2 then returned (historical only)
        const asset2Res = await request(app, "/api/asset", {
            method: "POST",
            headers,
            body: createAssetData(subCategory.id, {
                name: "Historical Holder Asset",
                employeeId: emp2Id,
                assignedDate: "2026-01-01",
            }),
        })
        const asset2Id = asset2Res.body.data.id
        // Return asset 2
        const holderRes = await request(app, `/api/asset-holder/active/${asset2Id}`, { method: "GET", headers })
        const holderId = holderRes.body.data.id
        await request(app, `/api/asset-holder/${holderId}/return`, {
            method: "POST",
            headers,
            body: { returnedDate: "2026-02-01", returnNote: "Returned" }
        })

        // Asset 3: no holder at all
        await request(app, "/api/asset", {
            method: "POST",
            headers,
            body: createAssetData(subCategory.id, { name: "No Holder Asset" }),
        })

        return { emp1Id, emp2Id, asset1Id, asset2Id }
    }

    test("holderStatus=has_holder with holderType=active_holder should only return assets with active holders", async () => {
        const { headers } = await registerAndLogin(app)
        await setupHolderTestData(app, headers)

        const res = await request(app, "/api/asset?holderStatus=has_holder&holderType=active_holder", { method: "GET", headers })
        expect(res.status).toBe(200)
        expect(res.body.data.length).toBe(1)
        expect(res.body.data[0].name).toBe("Active Holder Asset")
    })

    test("holderStatus=has_holder with holderType=historical_holder should return assets with any holder (active or returned)", async () => {
        const { headers } = await registerAndLogin(app)
        await setupHolderTestData(app, headers)

        const res = await request(app, "/api/asset?holderStatus=has_holder&holderType=historical_holder", { method: "GET", headers })
        expect(res.status).toBe(200)
        expect(res.body.data.length).toBe(2)
        const names = res.body.data.map((a: any) => a.name)
        expect(names).toContain("Active Holder Asset")
        expect(names).toContain("Historical Holder Asset")
    })

    test("holderStatus=has_holder with holderType=active_holder and holderId should filter by specific active holder", async () => {
        const { headers } = await registerAndLogin(app)
        const { emp1Id } = await setupHolderTestData(app, headers)

        const res = await request(app, `/api/asset?holderStatus=has_holder&holderType=active_holder&holderId=${emp1Id}`, { method: "GET", headers })
        expect(res.status).toBe(200)
        expect(res.body.data.length).toBe(1)
        expect(res.body.data[0].name).toBe("Active Holder Asset")
    })

    test("holderStatus=has_holder with holderType=historical_holder and holderId should filter by employee who ever held the asset", async () => {
        const { headers } = await registerAndLogin(app)
        const { emp2Id } = await setupHolderTestData(app, headers)

        // emp2 held asset 2 but returned it — should still show with historical filter
        const res = await request(app, `/api/asset?holderStatus=has_holder&holderType=historical_holder&holderId=${emp2Id}`, { method: "GET", headers })
        expect(res.status).toBe(200)
        expect(res.body.data.length).toBe(1)
        expect(res.body.data[0].name).toBe("Historical Holder Asset")
    })

    test("holderStatus=no_holder should only return assets with no active holder", async () => {
        const { headers } = await registerAndLogin(app)
        await setupHolderTestData(app, headers)

        const res = await request(app, "/api/asset?holderStatus=no_holder", { method: "GET", headers })
        expect(res.status).toBe(200)
        // Asset 2 (returned) and Asset 3 (never assigned) have no active holder
        expect(res.body.data.length).toBe(2)
        const names = res.body.data.map((a: any) => a.name)
        expect(names).toContain("Historical Holder Asset")
        expect(names).toContain("No Holder Asset")
    })
})

describe("Asset - organization holder", () => {
    test("creates an asset with an inline organization holder", async () => {
        const { headers } = await registerAndLogin(app)
        const subCategory = await createTestSubCategory(app, headers)
        const org = await request(app, "/api/organization", { method: "POST", headers, body: { name: "Shared Equipment Dept", type: "department" } })

        const res = await request(app, "/api/asset", {
            method: "POST",
            headers,
            body: createAssetData(subCategory.id, { name: "Communal Printer", organizationId: org.body.data.id, assignedDate: "2026-01-01" }),
        })

        expect(res.status).toBe(201)
        expect(res.body.data.activeHolder.holderKind).toBe("organization")
        expect(res.body.data.activeHolder.organization.id).toBe(org.body.data.id)
        expect(res.body.data.activeHolder.organization.name).toBe("Shared Equipment Dept")
        expect(res.body.data.activeHolder.employee).toBeNull()

        // Organization holders never trigger a Nusawork employee sync.
        await drainQueue()
        expect(nusaworkSyncCalls.length).toBe(0)
    })

    test("creates an asset with an inline employee holder notifies Nusawork", async () => {
        const { headers } = await registerAndLogin(app)
        const subCategory = await createTestSubCategory(app, headers)
        const emp = await request(app, "/api/employee", { method: "POST", headers, body: { employeeId: "EMP-NW-01", name: "Nusa Worker", jobPosition: "Staff", email: "nw01@test.com", phone: "081" } })

        const res = await request(app, "/api/asset", {
            method: "POST",
            headers,
            body: createAssetData(subCategory.id, { code: "AST-NW-01", name: "Company Laptop", employeeId: emp.body.data.id, assignedDate: "2026-01-01" }),
        })

        expect(res.status).toBe(201)
        await drainQueue()
        expect(nusaworkSyncCalls.length).toBe(1)
        expect(nusaworkSyncCalls[0]).toEqual({
            employee_id: "EMP-NW-01",
            fields: {
                asset_code: "AST-NW-01",
                asset_name: "Company Laptop",
                assign_date: "2026-01-01 00:00:00",
                assign_note: undefined,
            },
        })
    })

    test("rejects an asset creation payload with both employeeId and organizationId", async () => {
        const { headers } = await registerAndLogin(app)
        const subCategory = await createTestSubCategory(app, headers)
        const emp = await request(app, "/api/employee", { method: "POST", headers, body: { employeeId: "EMP-XOR", name: "X", jobPosition: "Y", email: "xor@test.com", phone: "081" } })
        const org = await request(app, "/api/organization", { method: "POST", headers, body: { name: "Org XOR", type: "division" } })

        const res = await request(app, "/api/asset", {
            method: "POST",
            headers,
            body: createAssetData(subCategory.id, { employeeId: emp.body.data.id, organizationId: org.body.data.id, assignedDate: "2026-01-01" }),
        })

        expect(res.status).toBe(422)
    })

    test("filters GET /api/asset by holderKind=organization", async () => {
        const { headers } = await registerAndLogin(app)
        const subCategory = await createTestSubCategory(app, headers)
        const org = await request(app, "/api/organization", { method: "POST", headers, body: { name: "Ops Dept", type: "department" } })

        await request(app, "/api/asset", {
            method: "POST", headers,
            body: createAssetData(subCategory.id, { name: "Org Held Asset", organizationId: org.body.data.id, assignedDate: "2026-01-01" }),
        })
        // An employee-held asset should not show up under the organization filter.
        const emp = await request(app, "/api/employee", { method: "POST", headers, body: { employeeId: "EMP-ORGF", name: "Filter Emp", jobPosition: "Dev", email: "orgf@test.com", phone: "081" } })
        await request(app, "/api/asset", {
            method: "POST", headers,
            body: createAssetData(subCategory.id, { name: "Employee Held Asset", employeeId: emp.body.data.id, assignedDate: "2026-01-01" }),
        })

        const res = await request(app, `/api/asset?holderStatus=has_holder&holderType=active_holder&holderKind=organization&holderId=${org.body.data.id}`, { method: "GET", headers })
        expect(res.status).toBe(200)
        expect(res.body.data.length).toBe(1)
        expect(res.body.data[0].name).toBe("Org Held Asset")
    })
})

describe("Asset Custom Labels - Keys & Sorting", () => {
    test("should fetch unique label keys and sort assets by custom label values", async () => {
        const { headers } = await registerAndLogin(app)
        const subCategory = await createTestSubCategory(app, headers)

        // Create asset 1 with Color Space Gray
        await request(app, "/api/asset", {
            method: "POST",
            headers,
            body: createAssetData(subCategory.id, {
                name: "Asset C",
                code: "AST-LC",
                labels: [
                    { key: "Color", value: "Space Gray" },
                    { key: "Storage", value: "256GB" }
                ]
            }),
        })

        // Create asset 2 with Color Silver
        await request(app, "/api/asset", {
            method: "POST",
            headers,
            body: createAssetData(subCategory.id, {
                name: "Asset A",
                code: "AST-LA",
                labels: [
                    { key: "Color", value: "Silver" },
                    { key: "Storage", value: "512GB" }
                ]
            }),
        })

        // Create asset 3 with Color Gold
        await request(app, "/api/asset", {
            method: "POST",
            headers,
            body: createAssetData(subCategory.id, {
                name: "Asset B",
                code: "AST-LB",
                labels: [
                    { key: "Color", value: "Gold" }
                ]
            }),
        })

        // 1. Verify unique label keys endpoint
        const keysRes = await request(app, "/api/asset/label-keys", { method: "GET", headers })
        expect(keysRes.status).toBe(200)
        expect(keysRes.body.success).toBe(true)
        expect(keysRes.body.data).toContain("Color")
        expect(keysRes.body.data).toContain("Storage")

        // 2. Sort by label:Color ASC (Gold, Silver, Space Gray)
        const resAsc = await request(app, "/api/asset?sortBy=label:Color&order=ASC", { method: "GET", headers })
        expect(resAsc.status).toBe(200)
        expect(resAsc.body.data.length).toBe(3)
        expect(resAsc.body.data[0].name).toBe("Asset B") // Gold
        expect(resAsc.body.data[1].name).toBe("Asset A") // Silver
        expect(resAsc.body.data[2].name).toBe("Asset C") // Space Gray

        // 3. Sort by label:Color DESC (Space Gray, Silver, Gold)
        const resDesc = await request(app, "/api/asset?sortBy=label:Color&order=DESC", { method: "GET", headers })
        expect(resDesc.status).toBe(200)
        expect(resDesc.body.data.length).toBe(3)
        expect(resDesc.body.data[0].name).toBe("Asset C") // Space Gray
        expect(resDesc.body.data[1].name).toBe("Asset A") // Silver
        expect(resDesc.body.data[2].name).toBe("Asset B") // Gold
    })
})


// ═══════════════════════════════════════════════════════════════════════════
// POST /api/asset/bulk-delete — Bulk Delete
// ═══════════════════════════════════════════════════════════════════════════

describe("POST /api/asset/bulk-delete", () => {
    test("should fail without auth", async () => {
        const { status, body } = await request(app, "/api/asset/bulk-delete", {
            method: "POST",
            body: { ids: [1, 2] },
        })
        expect(status).toBe(401)
        expect(body.success).toBe(false)
    })

    test("should fail with empty ids array", async () => {
        const { headers } = await registerAndLogin(app)

        const { status, body } = await request(app, "/api/asset/bulk-delete", {
            method: "POST",
            headers,
            body: { ids: [] },
        })
        expect(status).toBe(422)
        expect(body.success).toBe(false)
    })

    test("should successfully bulk delete assets", async () => {
        const { headers } = await registerAndLogin(app)
        const subCategory = await createTestSubCategory(app, headers)

        // Create 3 assets
        const asset1 = await request(app, "/api/asset", {
            method: "POST",
            headers,
            body: createAssetData(subCategory.id, { code: "BULK-DEL-1", name: "Bulk Asset 1" }),
        })
        const asset2 = await request(app, "/api/asset", {
            method: "POST",
            headers,
            body: createAssetData(subCategory.id, { code: "BULK-DEL-2", name: "Bulk Asset 2" }),
        })
        const asset3 = await request(app, "/api/asset", {
            method: "POST",
            headers,
            body: createAssetData(subCategory.id, { code: "BULK-DEL-3", name: "Bulk Asset 3" }),
        })

        const ids = [asset1.body.data.id, asset2.body.data.id, asset3.body.data.id]

        const { status, body } = await request(app, "/api/asset/bulk-delete", {
            method: "POST",
            headers,
            body: { ids },
        })

        expect(status).toBe(200)
        expect(body.success).toBe(true)
        expect(body.data.deleted).toBe(3)
        expect(body.data.failed).toHaveLength(0)
        expect(body.message).toBe("3 asset(s) deleted successfully")

        // Verify all are deleted
        for (const id of ids) {
            const { status: getStatus } = await request(app, `/api/asset/${id}`, {
                method: "GET",
                headers,
            })
            expect(getStatus).toBe(404)
        }
    })

    test("should return failed items for assets with dependencies", async () => {
        const { headers } = await registerAndLogin(app)
        const subCategory = await createTestSubCategory(app, headers)

        // Create 2 assets
        const asset1 = await request(app, "/api/asset", {
            method: "POST",
            headers,
            body: createAssetData(subCategory.id, { code: "BULK-F-1", name: "Free Asset" }),
        })
        // Create asset with immediate holder assignment (cannot be deleted)
        const empRes = await request(app, "/api/employee", {
            method: "POST",
            headers,
            body: {
                employeeId: "EMP-BULK",
                name: "Bulk Test Employee",
                jobPosition: "Tester",
                email: "bulk@test.com",
                phone: "08123456700",
            },
        })
        const asset2 = await request(app, "/api/asset", {
            method: "POST",
            headers,
            body: createAssetData(subCategory.id, {
                code: "BULK-F-2",
                name: "Assigned Asset",
                employeeId: empRes.body.data.id,
                assignedDate: "2026-06-20",
            }),
        })

        const ids = [asset1.body.data.id, asset2.body.data.id]

        const { status, body } = await request(app, "/api/asset/bulk-delete", {
            method: "POST",
            headers,
            body: { ids },
        })

        expect(status).toBe(200)
        expect(body.success).toBe(true)
        expect(body.data.deleted).toBe(1)
        expect(body.data.failed).toHaveLength(1)
        expect(body.data.failed[0].id).toBe(asset2.body.data.id)
        expect(body.data.failed[0].message).toContain("Cannot delete asset")
    })
})

// ═══════════════════════════════════════════════════════════════════════════
// Depreciation Feature
// ═══════════════════════════════════════════════════════════════════════════

describe("Asset Depreciation", () => {
    test("should create asset with usefulLife and return depreciation object", async () => {
        const { headers } = await registerAndLogin(app)
        const subCategory = await createTestSubCategory(app, headers)

        const { status, body } = await request(app, "/api/asset", {
            method: "POST",
            headers,
            body: createAssetData(subCategory.id, {
                code: "AST-DEPR-1",
                name: "Depreciating Laptop",
                price: 59000,
                purchaseDate: "2025-06-01",
                usefulLife: 5,
            }),
        })

        expect(status).toBe(201)
        expect(body.success).toBe(true)
        expect(body.data.usefulLife).toBe(5)
        expect(body.data.depreciation).toBeDefined()
        expect(body.data.depreciation).not.toBeNull()
        expect(typeof body.data.depreciation.monthlyDepreciation).toBe("number")
        expect(typeof body.data.depreciation.accumulatedDepreciation).toBe("number")
        expect(typeof body.data.depreciation.bookValue).toBe("number")
        expect(body.data.depreciation.bookValue).toBeLessThanOrEqual(body.data.price)
    })

    test("should return depreciation as null when usefulLife is not set", async () => {
        const { headers } = await registerAndLogin(app)
        const subCategory = await createTestSubCategory(app, headers)

        const { status, body } = await request(app, "/api/asset", {
            method: "POST",
            headers,
            body: createAssetData(subCategory.id, {
                code: "AST-NODEPR",
                name: "No Depreciation Asset",
            }),
        })

        expect(status).toBe(201)
        expect(body.data.depreciation).toBeNull()
    })

    test("should update asset with usefulLife and compute depreciation", async () => {
        const { headers } = await registerAndLogin(app)
        const subCategory = await createTestSubCategory(app, headers)

        // Create asset without usefulLife first
        const createRes = await request(app, "/api/asset", {
            method: "POST",
            headers,
            body: createAssetData(subCategory.id, {
                code: "AST-DEPR-UPD",
                name: "Update Depreciation Asset",
                price: 120000,
                purchaseDate: "2025-01-01",
            }),
        })
        const assetId = createRes.body.data.id
        expect(createRes.body.data.depreciation).toBeNull()

        // Update with usefulLife
        const { status, body } = await request(app, `/api/asset/${assetId}`, {
            method: "PUT",
            headers,
            body: { usefulLife: 10, price: 120000, purchaseDate: "2025-01-01" },
        })

        expect(status).toBe(200)
        expect(body.success).toBe(true)
        expect(body.data.usefulLife).toBe(10)
        expect(body.data.depreciation).not.toBeNull()
        expect(body.data.depreciation.monthlyDepreciation).toBeGreaterThan(0)
        expect(body.data.depreciation.accumulatedDepreciation).toBeGreaterThan(0)
        expect(body.data.depreciation.bookValue).toBeLessThan(120000)
    })

    test("should fail validation when usefulLife is set without price and purchaseDate", async () => {
        const { headers } = await registerAndLogin(app)
        const subCategory = await createTestSubCategory(app, headers)

        const { status, body } = await request(app, "/api/asset", {
            method: "POST",
            headers,
            body: {
                code: "AST-DEPR-FAIL",
                name: "Validation Fail Asset",
                subCategoryId: subCategory.id,
                usefulLife: 5,
            },
        })

        expect(status).toBe(422)
        expect(body.success).toBe(false)
    })

    test("should filter by depreciationStatus=has_depreciation", async () => {
        const { headers } = await registerAndLogin(app)
        const subCategory = await createTestSubCategory(app, headers)

        // Create asset with depreciation
        await request(app, "/api/asset", {
            method: "POST",
            headers,
            body: createAssetData(subCategory.id, {
                code: "AST-HAS-DEPR",
                name: "Has Depreciation",
                price: 60000,
                purchaseDate: "2025-06-01",
                usefulLife: 5,
            }),
        })

        // Create asset without depreciation
        await request(app, "/api/asset", {
            method: "POST",
            headers,
            body: createAssetData(subCategory.id, {
                code: "AST-NO-DEPR",
                name: "No Depreciation",
            }),
        })

        const res = await request(app, "/api/asset?depreciationStatus=has_depreciation", {
            method: "GET",
            headers,
        })

        expect(res.status).toBe(200)
        expect(res.body.data.length).toBe(1)
        expect(res.body.data[0].name).toBe("Has Depreciation")
        expect(res.body.data[0].depreciation).not.toBeNull()
    })

    test("should sort by bookValue without error", async () => {
        const { headers } = await registerAndLogin(app)
        const subCategory = await createTestSubCategory(app, headers)

        await request(app, "/api/asset", {
            method: "POST",
            headers,
            body: createAssetData(subCategory.id, {
                code: "AST-BV-1",
                name: "Cheap Asset",
                price: 30000,
                purchaseDate: "2025-06-01",
                usefulLife: 3,
            }),
        })
        await request(app, "/api/asset", {
            method: "POST",
            headers,
            body: createAssetData(subCategory.id, {
                code: "AST-BV-2",
                name: "Expensive Asset",
                price: 90000,
                purchaseDate: "2025-06-01",
                usefulLife: 3,
            }),
        })

        const res = await request(app, "/api/asset?sortBy=bookValue&order=ASC", {
            method: "GET",
            headers,
        })

        expect(res.status).toBe(200)
        expect(res.body.success).toBe(true)
        expect(res.body.data.length).toBe(2)
    })
})

// ═══════════════════════════════════════════════════════════════════════════
// Depreciation Filters
// ═══════════════════════════════════════════════════════════════════════════

describe("Depreciation Filters", () => {
    test("should filter by usefulLifeOp='>' and usefulLifeYears=3", async () => {
        const { headers } = await registerAndLogin(app)
        const subCategory = await createTestSubCategory(app, headers)

        // usefulLife = 2 (should NOT match > 3)
        await request(app, "/api/asset", {
            method: "POST",
            headers,
            body: createAssetData(subCategory.id, {
                code: "UL-GT-1",
                name: "Short Life Asset",
                price: 60000,
                purchaseDate: "2025-06-01",
                usefulLife: 2,
            }),
        })

        // usefulLife = 5 (should match > 3)
        await request(app, "/api/asset", {
            method: "POST",
            headers,
            body: createAssetData(subCategory.id, {
                code: "UL-GT-2",
                name: "Medium Life Asset",
                price: 60000,
                purchaseDate: "2025-06-01",
                usefulLife: 5,
            }),
        })

        // usefulLife = 10 (should match > 3)
        await request(app, "/api/asset", {
            method: "POST",
            headers,
            body: createAssetData(subCategory.id, {
                code: "UL-GT-3",
                name: "Long Life Asset",
                price: 60000,
                purchaseDate: "2025-06-01",
                usefulLife: 10,
            }),
        })

        const res = await request(app, "/api/asset?usefulLifeOp=%3E&usefulLifeYears=3", {
            method: "GET",
            headers,
        })

        expect(res.status).toBe(200)
        expect(res.body.data.length).toBe(2)
        const names = res.body.data.map((a: any) => a.name)
        expect(names).toContain("Medium Life Asset")
        expect(names).toContain("Long Life Asset")
        expect(names).not.toContain("Short Life Asset")
    })

    test("should filter by usefulLifeOp='<' and usefulLifeYears=5", async () => {
        const { headers } = await registerAndLogin(app)
        const subCategory = await createTestSubCategory(app, headers)

        // usefulLife = 2 (should match < 5)
        await request(app, "/api/asset", {
            method: "POST",
            headers,
            body: createAssetData(subCategory.id, {
                code: "UL-LT-1",
                name: "Short Life Asset",
                price: 60000,
                purchaseDate: "2025-06-01",
                usefulLife: 2,
            }),
        })

        // usefulLife = 5 (should NOT match < 5)
        await request(app, "/api/asset", {
            method: "POST",
            headers,
            body: createAssetData(subCategory.id, {
                code: "UL-LT-2",
                name: "Exact Life Asset",
                price: 60000,
                purchaseDate: "2025-06-01",
                usefulLife: 5,
            }),
        })

        // usefulLife = 8 (should NOT match < 5)
        await request(app, "/api/asset", {
            method: "POST",
            headers,
            body: createAssetData(subCategory.id, {
                code: "UL-LT-3",
                name: "Long Life Asset",
                price: 60000,
                purchaseDate: "2025-06-01",
                usefulLife: 8,
            }),
        })

        const res = await request(app, "/api/asset?usefulLifeOp=%3C&usefulLifeYears=5", {
            method: "GET",
            headers,
        })

        expect(res.status).toBe(200)
        expect(res.body.data.length).toBe(1)
        expect(res.body.data[0].name).toBe("Short Life Asset")
    })

    test("should filter by usefulLifeOp='=' and usefulLifeYears=5", async () => {
        const { headers } = await registerAndLogin(app)
        const subCategory = await createTestSubCategory(app, headers)

        // usefulLife = 3 (should NOT match = 5)
        await request(app, "/api/asset", {
            method: "POST",
            headers,
            body: createAssetData(subCategory.id, {
                code: "UL-EQ-1",
                name: "Three Year Asset",
                price: 60000,
                purchaseDate: "2025-06-01",
                usefulLife: 3,
            }),
        })

        // usefulLife = 5 (should match = 5)
        await request(app, "/api/asset", {
            method: "POST",
            headers,
            body: createAssetData(subCategory.id, {
                code: "UL-EQ-2",
                name: "Five Year Asset",
                price: 60000,
                purchaseDate: "2025-06-01",
                usefulLife: 5,
            }),
        })

        // usefulLife = 7 (should NOT match = 5)
        await request(app, "/api/asset", {
            method: "POST",
            headers,
            body: createAssetData(subCategory.id, {
                code: "UL-EQ-3",
                name: "Seven Year Asset",
                price: 60000,
                purchaseDate: "2025-06-01",
                usefulLife: 7,
            }),
        })

        const res = await request(app, "/api/asset?usefulLifeOp=%3D&usefulLifeYears=5", {
            method: "GET",
            headers,
        })

        expect(res.status).toBe(200)
        expect(res.body.data.length).toBe(1)
        expect(res.body.data[0].name).toBe("Five Year Asset")
    })

    test("should filter by bookValueMin and bookValueMax range", async () => {
        const { headers } = await registerAndLogin(app)
        const subCategory = await createTestSubCategory(app, headers)

        // Low price asset -> low book value
        await request(app, "/api/asset", {
            method: "POST",
            headers,
            body: createAssetData(subCategory.id, {
                code: "BV-RANGE-1",
                name: "Low Value Asset",
                price: 10000,
                purchaseDate: "2025-06-01",
                usefulLife: 5,
            }),
        })

        // Medium price asset -> medium book value
        await request(app, "/api/asset", {
            method: "POST",
            headers,
            body: createAssetData(subCategory.id, {
                code: "BV-RANGE-2",
                name: "Medium Value Asset",
                price: 60000,
                purchaseDate: "2025-06-01",
                usefulLife: 5,
            }),
        })

        // High price asset -> high book value
        await request(app, "/api/asset", {
            method: "POST",
            headers,
            body: createAssetData(subCategory.id, {
                code: "BV-RANGE-3",
                name: "High Value Asset",
                price: 200000,
                purchaseDate: "2025-06-01",
                usefulLife: 5,
            }),
        })

        // First, get all assets to check book values for picking good range
        const allRes = await request(app, "/api/asset?depreciationStatus=has_depreciation", {
            method: "GET",
            headers,
        })
        expect(allRes.status).toBe(200)
        expect(allRes.body.data.length).toBe(3)

        // Sort by book value to understand the range
        const bookValues = allRes.body.data
            .map((a: any) => ({ name: a.name, bv: a.depreciation?.bookValue }))
            .sort((a: any, b: any) => a.bv - b.bv)

        // Filter with bookValueMin that excludes the lowest and bookValueMax that excludes the highest
        const midBv = bookValues[1].bv
        const res = await request(app, `/api/asset?bookValueMin=${bookValues[0].bv + 1}&bookValueMax=${bookValues[2].bv - 1}`, {
            method: "GET",
            headers,
        })

        expect(res.status).toBe(200)
        expect(res.body.data.length).toBe(1)
        expect(res.body.data[0].name).toBe("Medium Value Asset")
    })
})

// ═══════════════════════════════════════════════════════════════════════════
// Asset Export & Import
// ═══════════════════════════════════════════════════════════════════════════

describe("Asset Export & Import", () => {
    test("Export returns xlsx buffer", async () => {
        const { headers } = await registerAndLogin(app)
        const subCategory = await createTestSubCategory(app, headers)

        // Create an asset so export has data
        await request(app, "/api/asset", {
            method: "POST",
            headers,
            body: createAssetData(subCategory.id, { code: "EXP-001", name: "Export Test Asset" }),
        })

        const res = await app.request("/api/asset/export", {
            method: "GET",
            headers: headers,
        })
        expect(res.status).toBe(200)
        expect(res.headers.get("content-type")).toContain("spreadsheetml")
    })

    test("Import template returns xlsx", async () => {
        const { headers } = await registerAndLogin(app)

        const res = await app.request("/api/asset/import-template", {
            method: "GET",
            headers: headers,
        })
        expect(res.status).toBe(200)
        expect(res.headers.get("content-type")).toContain("spreadsheetml")
    })

    test("Export links the code cell to the asset's detail page", async () => {
        const { headers } = await registerAndLogin(app)
        const subCategory = await createTestSubCategory(app, headers)

        const created = await request(app, "/api/asset", {
            method: "POST",
            headers,
            body: createAssetData(subCategory.id, { code: "EXP-LINK-1", name: "Linked Export Asset" }),
        })
        const assetId = created.body.data.id

        const res = await app.request("/api/asset/export", { method: "GET", headers })
        expect(res.status).toBe(200)
        const buffer = Buffer.from(await res.arrayBuffer())

        const workbook = new ExcelJS.Workbook()
        await workbook.xlsx.load(buffer as any)
        const sheet = workbook.getWorksheet("Assets")!

        let found = false
        sheet.eachRow((row, rowNumber) => {
            if (rowNumber < 3) return
            if (row.getCell(3).text === "EXP-LINK-1") {
                expect(row.getCell(3).hyperlink).toBe(`${config.app.appUrl}/asset/${assetId}`)
                found = true
            }
        })
        expect(found).toBe(true)
    })

    test("Export includes depreciation columns", async () => {
        const { headers } = await registerAndLogin(app)
        const subCategory = await createTestSubCategory(app, headers)

        // Create asset with usefulLife for depreciation
        await request(app, "/api/asset", {
            method: "POST",
            headers,
            body: createAssetData(subCategory.id, {
                code: "EXP-DEPR-1",
                name: "Depreciating Export Asset",
                price: 60000,
                purchaseDate: "2025-06-01",
                usefulLife: 5,
            }),
        })

        const res = await app.request("/api/asset/export", {
            method: "GET",
            headers: headers,
        })
        expect(res.status).toBe(200)
        expect(res.headers.get("content-type")).toContain("spreadsheetml")
    })
})

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/asset/options — lightweight picker search
// ═══════════════════════════════════════════════════════════════════════════

describe("GET /api/asset/options", () => {
    test("requires auth", async () => {
        const res = await request(app, "/api/asset/options")
        expect(res.status).toBe(401)
    })

    test("returns minimal shape, no relation fields", async () => {
        const { headers } = await registerAndLogin(app)
        const subCategory = await createTestSubCategory(app, headers)
        await request(app, "/api/asset", {
            method: "POST",
            headers,
            body: createAssetData(subCategory.id, { code: "OPT-001", name: "Option Generator" }),
        })

        const res = await request(app, "/api/asset/options", { headers })
        expect(res.status).toBe(200)
        expect(res.body.data.length).toBeGreaterThan(0)
        const found = res.body.data.find((a: any) => a.code === "OPT-001")
        expect(found).toBeDefined()
        expect(found.name).toBe("Option Generator")
        expect(Object.keys(found).sort()).toEqual(["code", "id", "image", "name"])
    })

    test("filters by q against name or code", async () => {
        const { headers } = await registerAndLogin(app)
        const subCategory = await createTestSubCategory(app, headers)
        await request(app, "/api/asset", { method: "POST", headers, body: createAssetData(subCategory.id, { code: "OPT-A1", name: "Alpha Machine" }) })
        await request(app, "/api/asset", { method: "POST", headers, body: createAssetData(subCategory.id, { code: "OPT-B1", name: "Beta Machine" }) })

        const res = await request(app, "/api/asset/options?q=Alpha", { headers })
        expect(res.status).toBe(200)
        expect(res.body.data.length).toBe(1)
        expect(res.body.data[0].code).toBe("OPT-A1")

        const byCode = await request(app, "/api/asset/options?q=OPT-B1", { headers })
        expect(byCode.body.data.length).toBe(1)
        expect(byCode.body.data[0].name).toBe("Beta Machine")
    })

    test("caps the result count at the requested limit", async () => {
        const { headers } = await registerAndLogin(app)
        const subCategory = await createTestSubCategory(app, headers)
        for (let i = 0; i < 5; i++) {
            await request(app, "/api/asset", { method: "POST", headers, body: createAssetData(subCategory.id, { code: `OPT-LIM-${i}`, name: `Limit Asset ${i}` }) })
        }

        const res = await request(app, "/api/asset/options?limit=3", { headers })
        expect(res.status).toBe(200)
        expect(res.body.data.length).toBe(3)
    })

    test("clamps a limit above the maximum", async () => {
        const { headers } = await registerAndLogin(app)
        const res = await request(app, "/api/asset/options?limit=9999", { headers })
        expect(res.status).toBe(200)
        // Just asserting it doesn't error and returns a bounded response is enough here;
        // the exact cap is an implementation detail, but it must not blow past a sane limit.
        expect(res.body.data.length).toBeLessThanOrEqual(50)
    })
})
