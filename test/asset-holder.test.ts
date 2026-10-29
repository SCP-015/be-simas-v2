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

// ── Mock Nusawork Helper to prevent real connections and record sync calls ──
export const nusaworkSyncCalls: any[] = []
export const nusaworkReturnCalls: any[] = []
export const nusaworkUpdateCalls: any[] = []
export const nusaworkDeleteCalls: any[] = []
export let nusaworkSyncShouldFail = false
export let nusaworkGroupsResponse: { id_group: number; items: { key: string; input: { value: string } }[] }[] = []
mock.module("../src/core/helpers/nusawork", () => ({
    nusaworkHelper: {
        createAssetSync: async (payload: any) => {
            nusaworkSyncCalls.push(payload)
            if (nusaworkSyncShouldFail) throw new Error("Nusawork unavailable")
            return { success: true, data: { id_group: 2877 } }
        },
        getAssetSyncGroups: async () => nusaworkGroupsResponse,
        returnAssetSync: async (payload: any) => {
            nusaworkReturnCalls.push(payload)
            if (nusaworkSyncShouldFail) throw new Error("Nusawork unavailable")
            return { success: true }
        },
        updateAssetSync: async (payload: any) => {
            nusaworkUpdateCalls.push(payload)
            if (nusaworkSyncShouldFail) throw new Error("Nusawork unavailable")
            return { success: true }
        },
        deleteAssetSync: async (payload: any) => {
            nusaworkDeleteCalls.push(payload)
            if (nusaworkSyncShouldFail) throw new Error("Nusawork unavailable")
            return { success: true }
        },
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

let app: Hono
let authHeaders: Record<string, string>
let assetId: number
let employeeId: number
let organizationId: number

beforeAll(async () => {
    await initTestDatabase()
    app = createTestApp()
})

afterAll(async () => {
    await destroyTestDatabase()
})

beforeEach(async () => {
    await cleanTestDatabase()
    nusaworkSyncCalls.length = 0
    nusaworkReturnCalls.length = 0
    nusaworkUpdateCalls.length = 0
    nusaworkDeleteCalls.length = 0
    nusaworkSyncShouldFail = false
    nusaworkGroupsResponse = []
    const login = await registerAndLogin(app)
    authHeaders = login.headers

    // Setup: Create Employee
    const empRes = await request(app, "/api/employee", {
        method: "POST",
        headers: authHeaders,
        body: {
            employeeId: "EMP-777",
            name: "Alice Assignment",
            jobPosition: "Developer",
            email: "alice@assignment.com",
            phone: "08123456789"
        }
    })
    employeeId = empRes.body.data.id

    // Setup: Create Organization
    const orgRes = await request(app, "/api/organization", {
        method: "POST",
        headers: authHeaders,
        body: { name: "Networking Dept", type: "department" },
    })
    organizationId = orgRes.body.data.id

    // Setup: Create Category and SubCategory
    const catRes = await request(app, "/api/category", {
        method: "POST",
        headers: authHeaders,
        body: { code: "CAT-H", name: "Category H" },
    })
    const subRes = await request(app, "/api/sub-category", {
        method: "POST",
        headers: authHeaders,
        body: { code: "SUB-H", name: "Sub Category H", categoryId: catRes.body.data.id },
    })

    // Setup: Create Asset
    const assetRes = await request(app, "/api/asset", {
        method: "POST",
        headers: authHeaders,
        body: { code: "AST-H01", name: "Dell Precision", subCategoryId: subRes.body.data.id },
    })
    assetId = assetRes.body.data.id
})

describe("Asset Holder API Tests", () => {
    test("POST /api/asset-holder - assign successfully", async () => {
        const payload = {
            assetId,
            employeeId,
            assignedDate: "2026-06-19",
            assignNote: "Given to Alice",
        }

        const res = await request(app, "/api/asset-holder", {
            method: "POST",
            headers: authHeaders,
            body: payload,
        })

        expect(res.status).toBe(201)
        expect(res.body.success).toBe(true)
        expect(res.body.data.asset.id).toBe(assetId)
        expect(res.body.data.employee.id).toBe(employeeId)
        expect(res.body.data.assignedDate).toBe("2026-06-19")
        expect(res.body.data.returnedDate).toBeNull()
        expect(res.body.data.assignNote).toBe("Given to Alice")
        expect(res.body.data.asset.name).toBe("Dell Precision")
        expect(res.body.data.employee.name).toBe("Alice Assignment")
        expect(res.body.data.createdBy.name).toBe("Test User")

        // Assigning to an employee notifies Nusawork.
        await drainQueue()
        expect(nusaworkSyncCalls.length).toBe(1)
        expect(nusaworkSyncCalls[0]).toEqual({
            employee_id: "EMP-777",
            fields: {
                asset_code: "AST-H01",
                asset_name: "Dell Precision",
                assign_date: "2026-06-19 00:00:00",
                assign_note: "Given to Alice",
            },
        })
    })

    test("POST /api/asset-holder - assignment still succeeds when Nusawork sync fails", async () => {
        nusaworkSyncShouldFail = true

        const res = await request(app, "/api/asset-holder", {
            method: "POST",
            headers: authHeaders,
            body: { assetId, employeeId, assignedDate: "2026-06-19" },
        })

        expect(res.status).toBe(201)
        expect(res.body.success).toBe(true)
        await drainQueue()
        expect(nusaworkSyncCalls.length).toBe(1) // it was attempted, just failed
    })

    test("POST /api/asset-holder - prevent double assignment", async () => {
        // First assignment
        await request(app, "/api/asset-holder", {
            method: "POST",
            headers: authHeaders,
            body: { assetId, employeeId, assignedDate: "2026-06-19" },
        })

        // Second assignment (should fail because asset is active)
        const res = await request(app, "/api/asset-holder", {
            method: "POST",
            headers: authHeaders,
            body: { assetId, employeeId, assignedDate: "2026-06-20" },
        })

        expect(res.status).toBe(400)
        expect(res.body.success).toBe(false)
        expect(res.body.message).toContain("assigned")
    })

    test("POST /api/asset-holder/:id/return - return successfully", async () => {
        // Assign first
        const assignRes = await request(app, "/api/asset-holder", {
            method: "POST",
            headers: authHeaders,
            body: { assetId, employeeId, assignedDate: "2026-06-19" },
        })
        const logId = assignRes.body.data.id

        // Return
        const returnRes = await request(app, `/api/asset-holder/${logId}/return`, {
            method: "POST",
            headers: authHeaders,
            body: { returnedDate: "2026-06-21", returnNote: "Returned clean" },
        })

        expect(returnRes.status).toBe(200)
        expect(returnRes.body.success).toBe(true)
        expect(returnRes.body.data.returnedDate).toBe("2026-06-21")
        expect(returnRes.body.data.returnNote).toBe("Returned clean")
        expect(returnRes.body.data.returnedBy.name).toBe("Test User")

        // Now asset should be free to be assigned again!
        const reassignRes = await request(app, "/api/asset-holder", {
            method: "POST",
            headers: authHeaders,
            body: { assetId, employeeId, assignedDate: "2026-06-22" },
        })
        expect(reassignRes.status).toBe(201)
    })

    test("POST /api/asset-holder/:id/return - notifies Nusawork using the id_group matching this holder", async () => {
        const assignRes = await request(app, "/api/asset-holder", {
            method: "POST",
            headers: authHeaders,
            body: { assetId, employeeId, assignedDate: "2026-06-19" },
        })
        const logId = assignRes.body.data.id
        nusaworkSyncCalls.length = 0 // discard the assign-time call

        // Simulate Nusawork's note-group listing containing this holder's id.
        nusaworkGroupsResponse = [
            { id_group: 1111, items: [{ key: "id_holder", input: { value: "999999" } }] },
            { id_group: 2877, items: [{ key: "id_holder", input: { value: String(logId) } }] },
        ]

        const returnRes = await request(app, `/api/asset-holder/${logId}/return`, {
            method: "POST",
            headers: authHeaders,
            body: { returnedDate: "2026-08-20 12:00:00", returnNote: "mantap" },
        })

        expect(returnRes.status).toBe(200)
        await drainQueue()
        expect(nusaworkReturnCalls.length).toBe(1)
        expect(nusaworkReturnCalls[0]).toEqual({
            employee_id: "EMP-777",
            id_group: 2877,
            fields: {
                return_date: "2026-08-20 12:00:00",
                return_note: "mantap",
            },
        })
    })

    test("POST /api/asset-holder/:id/return - return still succeeds when no matching Nusawork group is found", async () => {
        const assignRes = await request(app, "/api/asset-holder", {
            method: "POST",
            headers: authHeaders,
            body: { assetId, employeeId, assignedDate: "2026-06-19" },
        })
        const logId = assignRes.body.data.id
        nusaworkGroupsResponse = [] // nothing matches

        const returnRes = await request(app, `/api/asset-holder/${logId}/return`, {
            method: "POST",
            headers: authHeaders,
            body: { returnedDate: "2026-06-21" },
        })

        expect(returnRes.status).toBe(200)
        await drainQueue()
        expect(nusaworkReturnCalls.length).toBe(0)
    })

    test("POST /api/asset-holder/:id/return - return still succeeds when Nusawork sync fails", async () => {
        const assignRes = await request(app, "/api/asset-holder", {
            method: "POST",
            headers: authHeaders,
            body: { assetId, employeeId, assignedDate: "2026-06-19" },
        })
        const logId = assignRes.body.data.id
        nusaworkGroupsResponse = [{ id_group: 2877, items: [{ key: "id_holder", input: { value: String(logId) } }] }]
        nusaworkSyncShouldFail = true

        const returnRes = await request(app, `/api/asset-holder/${logId}/return`, {
            method: "POST",
            headers: authHeaders,
            body: { returnedDate: "2026-06-21" },
        })

        expect(returnRes.status).toBe(200)
        await drainQueue()
        expect(nusaworkReturnCalls.length).toBe(1)
    })

    test("POST /api/asset-holder/:id/return - prevent double return", async () => {
        // Assign
        const assignRes = await request(app, "/api/asset-holder", {
            method: "POST",
            headers: authHeaders,
            body: { assetId, employeeId, assignedDate: "2026-06-19" },
        })
        const logId = assignRes.body.data.id

        // Return 1st time
        await request(app, `/api/asset-holder/${logId}/return`, {
            method: "POST",
            headers: authHeaders,
            body: { returnedDate: "2026-06-21" },
        })

        // Return 2nd time (should fail)
        const returnRes2 = await request(app, `/api/asset-holder/${logId}/return`, {
            method: "POST",
            headers: authHeaders,
            body: { returnedDate: "2026-06-22" },
        })

        expect(returnRes2.status).toBe(400)
        expect(returnRes2.body.success).toBe(false)
        expect(returnRes2.body.message).toContain("returned")
    })

    test("GET /api/asset-holder/active/:assetId - retrieve active holder", async () => {
        // Initially no active holder
        const resInit = await request(app, `/api/asset-holder/active/${assetId}`, {
            headers: authHeaders,
        })
        expect(resInit.status).toBe(200)
        expect(resInit.body.data).toBeNull()

        // Assign
        await request(app, "/api/asset-holder", {
            method: "POST",
            headers: authHeaders,
            body: { assetId, employeeId, assignedDate: "2026-06-19" },
        })

        // Now should have active holder
        const resActive = await request(app, `/api/asset-holder/active/${assetId}`, {
            headers: authHeaders,
        })
        expect(resActive.status).toBe(200)
        expect(resActive.body.data.employee.name).toBe("Alice Assignment")
    })

    test("POST /api/asset-holder - should fail when asset status is not active", async () => {
        // Set asset status to "under_repair"
        await request(app, "/api/asset-status", {
            method: "POST",
            headers: authHeaders,
            body: { assetId, status: "under_repair", note: "Repairing" },
        })

        // Try to assign - should fail
        const res = await request(app, "/api/asset-holder", {
            method: "POST",
            headers: authHeaders,
            body: { assetId, employeeId, assignedDate: "2026-07-01" },
        })

        expect(res.status).toBe(400)
        expect(res.body.success).toBe(false)
        expect(res.body.message).toContain("active")
    })

    test("POST /api/asset-holder - should succeed when asset status is active", async () => {
        // Set asset status to "active"
        await request(app, "/api/asset-status", {
            method: "POST",
            headers: authHeaders,
            body: { assetId, status: "active" },
        })

        // Assign - should succeed
        const res = await request(app, "/api/asset-holder", {
            method: "POST",
            headers: authHeaders,
            body: { assetId, employeeId, assignedDate: "2026-07-01" },
        })

        expect(res.status).toBe(201)
        expect(res.body.success).toBe(true)
    })
})

describe("Asset Holder API Tests - organization holder", () => {
    test("POST /api/asset-holder - assign to organization successfully", async () => {
        const res = await request(app, "/api/asset-holder", {
            method: "POST",
            headers: authHeaders,
            body: { assetId, holderKind: "organization", organizationId, assignedDate: "2026-06-19", assignNote: "Shared equipment" },
        })

        expect(res.status).toBe(201)
        expect(res.body.success).toBe(true)
        expect(res.body.data.holderKind).toBe("organization")
        expect(res.body.data.organization.id).toBe(organizationId)
        expect(res.body.data.organization.name).toBe("Networking Dept")
        expect(res.body.data.employee).toBeNull()

        // Organization holders never trigger a Nusawork employee sync.
        expect(nusaworkSyncCalls.length).toBe(0)
    })

    test("POST /api/asset-holder - prevent double assignment to organization", async () => {
        await request(app, "/api/asset-holder", {
            method: "POST",
            headers: authHeaders,
            body: { assetId, holderKind: "organization", organizationId, assignedDate: "2026-06-19" },
        })

        const res = await request(app, "/api/asset-holder", {
            method: "POST",
            headers: authHeaders,
            body: { assetId, holderKind: "organization", organizationId, assignedDate: "2026-06-20" },
        })

        expect(res.status).toBe(400)
        expect(res.body.message).toContain("assigned")
    })

    test("POST /api/asset-holder/:id/return - return an organization holder successfully", async () => {
        const assignRes = await request(app, "/api/asset-holder", {
            method: "POST",
            headers: authHeaders,
            body: { assetId, holderKind: "organization", organizationId, assignedDate: "2026-06-19" },
        })
        const logId = assignRes.body.data.id

        const returnRes = await request(app, `/api/asset-holder/${logId}/return`, {
            method: "POST",
            headers: authHeaders,
            body: { returnedDate: "2026-06-21" },
        })

        expect(returnRes.status).toBe(200)
        expect(returnRes.body.data.returnedDate).toBe("2026-06-21")

        // Organization holders never trigger a Nusawork employee sync.
        expect(nusaworkReturnCalls.length).toBe(0)

        // Asset should be free to assign again
        const reassignRes = await request(app, "/api/asset-holder", {
            method: "POST",
            headers: authHeaders,
            body: { assetId, holderKind: "organization", organizationId, assignedDate: "2026-06-22" },
        })
        expect(reassignRes.status).toBe(201)
    })

    test("GET /api/asset-holder/active/:assetId - retrieve active organization holder", async () => {
        await request(app, "/api/asset-holder", {
            method: "POST",
            headers: authHeaders,
            body: { assetId, holderKind: "organization", organizationId, assignedDate: "2026-06-19" },
        })

        const res = await request(app, `/api/asset-holder/active/${assetId}`, { headers: authHeaders })
        expect(res.status).toBe(200)
        expect(res.body.data.holderKind).toBe("organization")
        expect(res.body.data.organization.name).toBe("Networking Dept")
    })

    test("POST /api/asset-holder - rejects assigning to an inactive organization", async () => {
        const inactiveOrg = await request(app, "/api/organization", {
            method: "POST",
            headers: authHeaders,
            body: { name: "Retired Dept", type: "department", isActive: false },
        })

        const res = await request(app, "/api/asset-holder", {
            method: "POST",
            headers: authHeaders,
            body: { assetId, holderKind: "organization", organizationId: inactiveOrg.body.data.id, assignedDate: "2026-06-19" },
        })

        expect(res.status).toBe(400)
        expect(res.body.message).toContain("inactive organization")
    })

    test("POST /api/asset-holder - rejects both employeeId and organizationId set", async () => {
        const res = await request(app, "/api/asset-holder", {
            method: "POST",
            headers: authHeaders,
            body: { assetId, holderKind: "employee", employeeId, organizationId, assignedDate: "2026-06-19" },
        })

        expect(res.status).toBe(422)
    })

    test("POST /api/asset-holder - rejects organization holderKind with no organizationId", async () => {
        const res = await request(app, "/api/asset-holder", {
            method: "POST",
            headers: authHeaders,
            body: { assetId, holderKind: "organization", assignedDate: "2026-06-19" },
        })

        expect(res.status).toBe(422)
    })
})

describe("Asset Holder API Tests - update & delete", () => {
    async function assign(): Promise<number> {
        const res = await request(app, "/api/asset-holder", {
            method: "POST",
            headers: authHeaders,
            body: { assetId, employeeId, assignedDate: "2026-06-19", assignNote: "Original note" },
        })
        return res.body.data.id
    }

    test("PUT /api/asset-holder/:id - edits assign data while still active", async () => {
        const id = await assign()
        nusaworkGroupsResponse = [{ id_group: 4001, items: [{ key: "id_holder", input: { value: String(id) } }] }]

        const res = await request(app, `/api/asset-holder/${id}`, {
            method: "PUT",
            headers: authHeaders,
            body: { assignedDate: "2026-06-20", assignNote: "Corrected note" },
        })

        expect(res.status).toBe(200)
        expect(res.body.data.assignedDate).toBe("2026-06-20")
        expect(res.body.data.assignNote).toBe("Corrected note")

        // Editing an active employee holder re-syncs its Nusawork note.
        await drainQueue()
        expect(nusaworkUpdateCalls.length).toBe(1)
        expect(nusaworkUpdateCalls[0]).toEqual({
            employee_id: "EMP-777",
            id_group: 4001,
            fields: {
                asset_code: "AST-H01",
                asset_name: "Dell Precision",
                assign_date: "2026-06-20 00:00:00",
                assign_note: "Corrected note",
                return_date: undefined,
                return_note: undefined,
            },
        })
    })

    test("PUT /api/asset-holder/:id - switches holder from employee to organization while active", async () => {
        const id = await assign()

        // employeeId: null mirrors what the FE actually sends when toggling the holder kind radio —
        // exercising an explicit null (not just an omitted field) here is what catches a stale-relation regression.
        const res = await request(app, `/api/asset-holder/${id}`, {
            method: "PUT",
            headers: authHeaders,
            body: { holderKind: "organization", employeeId: null, organizationId },
        })

        expect(res.status).toBe(200)
        expect(res.body.data.holderKind).toBe("organization")
        expect(res.body.data.organization.id).toBe(organizationId)
        expect(res.body.data.employee).toBeNull()

        // Re-fetch independently to rule out any in-memory staleness in the update response itself.
        const show = await request(app, `/api/asset-holder/${id}`, { headers: authHeaders })
        expect(show.body.data.employee).toBeNull()
        expect(show.body.data.organization.id).toBe(organizationId)

        // The resulting holder is an organization, so no Nusawork sync fires.
        await drainQueue()
        expect(nusaworkUpdateCalls.length).toBe(0)
    })

    test("PUT /api/asset-holder/:id - rejects editing return data while still active", async () => {
        const id = await assign()

        const res = await request(app, `/api/asset-holder/${id}`, {
            method: "PUT",
            headers: authHeaders,
            body: { returnedDate: "2026-06-21" },
        })

        expect(res.status).toBe(400)
        expect(res.body.message).toContain("Return data")
    })

    test("PUT /api/asset-holder/:id - rejects assigning to an inactive employee", async () => {
        const id = await assign()
        const inactiveEmp = await request(app, "/api/employee", {
            method: "POST",
            headers: authHeaders,
            body: { employeeId: "EMP-INACTIVE", name: "Retired", jobPosition: "N/A", email: "retired@test.com", phone: "081", isActive: false },
        })

        const res = await request(app, `/api/asset-holder/${id}`, {
            method: "PUT",
            headers: authHeaders,
            body: { employeeId: inactiveEmp.body.data.id },
        })

        expect(res.status).toBe(400)
        expect(res.body.message).toContain("inactive employee")
    })

    test("PUT /api/asset-holder/:id - rejects both employeeId and organizationId set", async () => {
        const id = await assign()

        const res = await request(app, `/api/asset-holder/${id}`, {
            method: "PUT",
            headers: authHeaders,
            body: { employeeId, organizationId },
        })

        expect(res.status).toBe(422)
    })

    test("PUT /api/asset-holder/:id - after return, edits both assign and return data", async () => {
        const id = await assign()
        nusaworkGroupsResponse = [{ id_group: 4002, items: [{ key: "id_holder", input: { value: String(id) } }] }]
        await request(app, `/api/asset-holder/${id}/return`, {
            method: "POST",
            headers: authHeaders,
            body: { returnedDate: "2026-06-21", returnNote: "Original return note" },
        })
        nusaworkUpdateCalls.length = 0

        const res = await request(app, `/api/asset-holder/${id}`, {
            method: "PUT",
            headers: authHeaders,
            body: { assignNote: "Corrected assign note", returnedDate: "2026-06-22", returnNote: "Corrected return note" },
        })

        expect(res.status).toBe(200)
        expect(res.body.data.assignNote).toBe("Corrected assign note")
        expect(res.body.data.returnedDate).toBe("2026-06-22")
        expect(res.body.data.returnNote).toBe("Corrected return note")

        await drainQueue()
        expect(nusaworkUpdateCalls.length).toBe(1)
        expect(nusaworkUpdateCalls[0]).toEqual({
            employee_id: "EMP-777",
            id_group: 4002,
            fields: {
                asset_code: "AST-H01",
                asset_name: "Dell Precision",
                assign_date: "2026-06-19 00:00:00",
                assign_note: "Corrected assign note",
                return_date: "2026-06-22 00:00:00",
                return_note: "Corrected return note",
            },
        })
    })

    test("PUT /api/asset-holder/:id - returns 404 for a non-existent record", async () => {
        const res = await request(app, "/api/asset-holder/999999", {
            method: "PUT",
            headers: authHeaders,
            body: { assignNote: "x" },
        })

        expect(res.status).toBe(404)
    })

    test("DELETE /api/asset-holder/:id - deletes the record", async () => {
        const id = await assign()
        nusaworkGroupsResponse = [{ id_group: 2976, items: [{ key: "id_holder", input: { value: String(id) } }] }]

        const res = await request(app, `/api/asset-holder/${id}`, { method: "DELETE", headers: authHeaders })
        expect(res.status).toBe(200)

        const show = await request(app, `/api/asset-holder/${id}`, { headers: authHeaders })
        expect(show.status).toBe(404)

        // Deleting the record also removes its Nusawork note.
        await drainQueue()
        expect(nusaworkDeleteCalls.length).toBe(1)
        expect(nusaworkDeleteCalls[0]).toEqual({ employee_id: "EMP-777", id_group: 2976 })
    })

    test("DELETE /api/asset-holder/:id - deletion still succeeds when Nusawork sync fails", async () => {
        const id = await assign()
        nusaworkGroupsResponse = [{ id_group: 2976, items: [{ key: "id_holder", input: { value: String(id) } }] }]
        nusaworkSyncShouldFail = true

        const res = await request(app, `/api/asset-holder/${id}`, { method: "DELETE", headers: authHeaders })
        expect(res.status).toBe(200)
        await drainQueue()
        expect(nusaworkDeleteCalls.length).toBe(1)
    })

    test("DELETE /api/asset-holder/:id - deleting the active holder frees the asset", async () => {
        const id = await assign()
        await request(app, `/api/asset-holder/${id}`, { method: "DELETE", headers: authHeaders })

        const active = await request(app, `/api/asset-holder/active/${assetId}`, { headers: authHeaders })
        expect(active.body.data).toBeNull()

        // Asset should be assignable again
        const reassign = await request(app, "/api/asset-holder", {
            method: "POST",
            headers: authHeaders,
            body: { assetId, employeeId, assignedDate: "2026-06-23" },
        })
        expect(reassign.status).toBe(201)
    })

    test("DELETE /api/asset-holder/:id - returns 404 for a non-existent record", async () => {
        const res = await request(app, "/api/asset-holder/999999", { method: "DELETE", headers: authHeaders })
        expect(res.status).toBe(404)
    })

    test("DELETE /api/asset-holder/:id - deleting an organization holder never triggers a Nusawork sync", async () => {
        const assignRes = await request(app, "/api/asset-holder", {
            method: "POST",
            headers: authHeaders,
            body: { assetId, holderKind: "organization", organizationId, assignedDate: "2026-06-19" },
        })
        const id = assignRes.body.data.id

        const res = await request(app, `/api/asset-holder/${id}`, { method: "DELETE", headers: authHeaders })
        expect(res.status).toBe(200)
        expect(nusaworkDeleteCalls.length).toBe(0)
    })
})
