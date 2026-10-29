import axios, { AxiosInstance } from "axios"
import { config } from "../../config/config"

export class NusaworkHelper {
    private readonly http: AxiosInstance = axios.create({
        baseURL: config.nusawork.apiUrl,
        headers: {
            Accept: 'application/json',
        },
    })

    private async getToken(): Promise<string> {
        const res = await this.http.post<any>('/auth/api/oauth/token', {
            grant_type: 'client_credentials',
            client_id: config.nusawork.clientId,
            client_secret: config.nusawork.clientSecret,
        }, {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
        })

        return res.data.access_token as string
    }

    async getEmployees(): Promise<any[]> {
        const token = await this.getToken()

        const res = await this.http.post<any>('/emp/api/v4.2/client/employee/filter', {
            fields: { active_status: ['active', 'Resign'] },
            is_paginate: false,
            multi_value: false,
            currentPage: 1,
        }, {
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
        })

        return (res?.data?.data as any[]) ?? []
    }

    async getBranch(): Promise<any[]> {
        const token = await this.getToken()

        const res = await this.http.get<any>('/emp/api/branch', {
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
        })

        return (res?.data?.data as any[]) ?? []
    }

    async getOrganization(): Promise<any[]> {
        const token = await this.getToken()

        const res = await this.http.get<any>('/emp/api/organization', {
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
        })

        return (res?.data?.data as any[]) ?? []
    }

    async authLogin(email: string, password: string): Promise<boolean> {
        try {
            const res = await this.http.post<any>('/auth/api/oauth/token', {
                grant_type: 'password',
                username: email,
                password: password,
                client_id: config.nusawork.auth.clientId,
                client_secret: config.nusawork.auth.clientSecret,
            }, {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                validateStatus: () => true,
            })

            return res.status === 200
        } catch {
            return false
        }
    }

    async createAssetSync(payload: {
        employee_id: string
        fields: {
            asset_code: string
            asset_name: string
            assign_date: string
            assign_note?: string
            id_holder?: number
        }
    }): Promise<any> {
        const token = await this.getToken()
        const res = await this.http.post<any>(`/emp/api/client/v4/note/web/${config.nusawork.noteTypeId}/employee`, payload, {
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            validateStatus: () => true,
        })
        return res.data
    }

    /** Fetches the employee's existing asset-note groups/items — used to locate the `id_group` matching a given `id_holder` before submitting a return. Same note-type id (202) as `createAssetSync`/`returnAssetSync`. */
    async getAssetSyncGroups(employeeId: string): Promise<{ id_group: number; items: { key: string; input: { value: string } }[] }[]> {
        const token = await this.getToken()
        const res = await this.http.get<any>(`/emp/api/client/v4/note/web/${config.nusawork.noteTypeId}/employee`, {
            params: { employee_id: employeeId },
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            validateStatus: () => true,
        })
        if (!Array.isArray(res.data?.data)) {
            console.error(`[NusaworkHelper] Unexpected response fetching note groups for employee ${employeeId} (status ${res.status}):`, JSON.stringify(res.data))
            return []
        }
        return res.data.data
    }

    async returnAssetSync(payload: {
        employee_id: string
        id_group: number
        fields: {
            return_date: string
            return_note?: string
        }
    }): Promise<any> {
        const token = await this.getToken()
        const res = await this.http.put<any>(`/emp/api/client/v4/note/web/${config.nusawork.noteTypeId}/employee`, payload, {
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            validateStatus: () => true,
        })
        return res.data
    }

    /** Re-submits every field of an existing note — used when the asset itself is edited (code/name) so historical Nusawork notes don't go stale. */
    async updateAssetSync(payload: {
        employee_id: string
        id_group: number
        fields: {
            asset_code: string
            asset_name: string
            assign_date: string
            assign_note?: string
            return_date?: string
            return_note?: string
        }
    }): Promise<any> {
        const token = await this.getToken()
        const res = await this.http.put<any>(`/emp/api/client/v4/note/web/${config.nusawork.noteTypeId}/employee`, payload, {
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            validateStatus: () => true,
        })
        return res.data
    }

    /** Deletes a note entirely — used when the underlying AssetHolder record itself is deleted. */
    async deleteAssetSync(payload: { employee_id: string; id_group: number }): Promise<any> {
        const token = await this.getToken()
        const res = await this.http.delete<any>(`/emp/api/client/v4/note/web/${config.nusawork.noteTypeId}/employee`, {
            params: { employee_id: payload.employee_id, id_group: payload.id_group },
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            validateStatus: () => true,
        })
        return res.data
    }
}

export const nusaworkHelper = new NusaworkHelper()