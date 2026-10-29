import { AppDataSource } from "../config/database"
import { nusaworkHelper } from "../core/helpers/nusawork"
import { logger } from "../core/helpers/logger"

async function run() {
    logger.info("Initializing database connection for returned notes backfill...")
    await AppDataSource.initialize()

    const rows = await AppDataSource.query(`
        SELECT DISTINCT e.employee_id as external_id, e.name
        FROM asset_holders ah
        JOIN employees e ON e.id = ah.employee_id
        WHERE ah.holder_kind = 'employee' AND ah.returned_date IS NOT NULL
        ORDER BY e.name ASC
    `)

    logger.info(`Found ${rows.length} unique employees with historical returned assets.`)

    let totalUpdated = 0
    let skippedEmployees = 0

    for (let i = 0; i < rows.length; i++) {
        const { external_id: empExternalId, name } = rows[i]

        if (!empExternalId) {
            skippedEmployees++
            continue
        }

        try {
            const groups = await nusaworkHelper.getAssetSyncGroups(empExternalId)

            for (const group of groups) {
                const getVal = (key: string) => group.items?.find((it) => it.key === key)?.input?.value
                const returnDate = getVal("return_date")
                const assetStatus = getVal("asset_status")

                // Only update if note has a return date but asset_status is not "Returned"
                if (returnDate && assetStatus !== "Returned") {
                    const assetCode = getVal("asset_code") || ""
                    const assetName = getVal("asset_name") || ""
                    const assignDate = getVal("assign_date") || ""
                    const assignNote = getVal("assign_note") || undefined
                    const returnNote = getVal("return_note") || undefined

                    await nusaworkHelper.updateAssetSync({
                        employee_id: empExternalId,
                        id_group: group.id_group,
                        fields: {
                            asset_code: assetCode,
                            asset_name: assetName,
                            assign_date: assignDate,
                            assign_note: assignNote,
                            return_date: returnDate,
                            return_note: returnNote,
                            asset_status: "Returned",
                        },
                    })

                    // Match and save nusawork_group_id to DB if missing
                    if (assetCode) {
                        await AppDataSource.query(
                            `
                            UPDATE asset_holders ah
                            JOIN assets a ON a.id = ah.asset_id
                            JOIN employees e ON e.id = ah.employee_id
                            SET ah.nusawork_group_id = ?
                            WHERE e.employee_id = ? AND a.code = ? AND ah.returned_date IS NOT NULL AND ah.nusawork_group_id IS NULL
                            LIMIT 1
                        `,
                            [group.id_group, empExternalId, assetCode]
                        )
                    }

                    totalUpdated++
                    logger.info(`  -> Note ${group.id_group} (${assetCode} - ${name}) set to "Returned"`)
                }
            }

            if ((i + 1) % 10 === 0 || i === rows.length - 1) {
                logger.info(`[${i + 1}/${rows.length}] Progress: ${totalUpdated} returned notes updated so far...`)
            }
        } catch (err: any) {
            logger.error(`Error processing employee ${empExternalId} (${name}): ${err?.message || err}`)
        }
    }

    logger.info("============================================================")
    logger.info(`Returned notes backfill complete: ${totalUpdated} notes updated to "Returned".`)
    logger.info("============================================================")
    process.exit(0)
}

run().catch((err) => {
    logger.error("Job crashed", { error: err?.message, stack: err?.stack })
    process.exit(1)
})
