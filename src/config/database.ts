import "reflect-metadata"
import { DataSource } from "typeorm"
import { User } from "../modules/user/entities/user.entity"
import { Category } from "../modules/category/entities/category.entity"
import { SubCategory } from "../modules/sub-category/entities/sub-category.entity"
import { Employee } from "../modules/employee/entities/employee.entity"
import { Branch } from "../modules/branch/entities/branch.entity"
import { Location } from "../modules/location/entities/location.entity"
import { Asset } from "../modules/asset/entities/asset.entity"
import { AssetLabel } from "../modules/asset/entities/asset-label.entity"
import { Attachment } from "../modules/attachment/entities/attachment.entity"
import { AssetMaintenance } from "../modules/asset-maintenance/entities/asset-maintenance.entity"
import { AssetNote } from "../modules/asset-note/entities/asset-note.entity"
import { AssetLocation } from "../modules/asset-location/entities/asset-location.entity"
import { AssetHolder } from "../modules/asset-holder/entities/asset-holder.entity"
import { AssetLog } from "../modules/asset-log/entities/asset-log.entity"
import { AssetStatus } from "../modules/asset-status/entities/asset-status.entity"
import { AssetSchedule } from "../modules/asset-schedule/entities/asset-schedule.entity"
import { AssetScheduleAsset } from "../modules/asset-schedule/entities/asset-schedule-asset.entity"
import { AssetScheduleUser } from "../modules/asset-schedule/entities/asset-schedule-user.entity"
import { Handover } from "../modules/handover/entities/handover.entity"
import { HandoverItem } from "../modules/handover/entities/handover-item.entity"
import { HandoverStockItem } from "../modules/handover/entities/handover-stock-item.entity"
import { HandoverCustomItem } from "../modules/handover/entities/handover-custom-item.entity"
import { HandoverField } from "../modules/handover-field/entities/handover-field.entity"
import { Inventory } from "../modules/inventory/entities/inventory.entity"
import { InventoryLabel } from "../modules/inventory/entities/inventory-label.entity"
import { InventoryVariant } from "../modules/inventory-variant/entities/inventory-variant.entity"
import { InventoryStockBalance } from "../modules/inventory-stock/entities/inventory-stock-balance.entity"
import { InventoryStockOut } from "../modules/inventory-stock-out/entities/inventory-stock-out.entity"
import { InventoryStockOutItem } from "../modules/inventory-stock-out/entities/inventory-stock-out-item.entity"
import { InventoryStockTransfer } from "../modules/inventory-stock-transfer/entities/inventory-stock-transfer.entity"
import { InventoryStockTransferItem } from "../modules/inventory-stock-transfer/entities/inventory-stock-transfer-item.entity"
import { InventoryStockIn } from "../modules/inventory-stock-in/entities/inventory-stock-in.entity"
import { InventoryStockInItem } from "../modules/inventory-stock-in/entities/inventory-stock-in-item.entity"
import { InventoryStockOpname } from "../modules/inventory-stock-opname/entities/inventory-stock-opname.entity"
import { InventoryStockOpnameItem } from "../modules/inventory-stock-opname/entities/inventory-stock-opname-item.entity"
import { InventoryLog } from "../modules/inventory-log/entities/inventory-log.entity"
import { Role } from "../modules/role/entities/role.entity"
import { Permission } from "../modules/role/entities/permission.entity"
import { Organization } from "../modules/organization/entities/organization.entity"
import { config } from "./config"
import { PasswordResetToken } from "../modules/auth/entities/password-reset-token.entity"
import { Job } from "../modules/queue/entities/job.entity"
import { FailedJob } from "../modules/queue/entities/failed-job.entity"
import { Transfer } from "../modules/transfer/entities/transfer.entity"

/**
 * TypeORM Database Configuration
 * 
 * Access via `AppDataSource` (default) atau `getDataSource()`.
 * Untuk testing, gunakan `setDataSource()` untuk override ke test database.
 */

const defaultDataSource = new DataSource({
    type: config.database.type,
    host: config.database.host,
    port: config.database.port,
    username: config.database.user,
    password: config.database.pass,
    database: config.database.name,
    synchronize: config.database.sync,
    entities: [User, Category, SubCategory, Employee, Branch, Location, Asset, AssetLabel, Attachment, AssetMaintenance, AssetNote, AssetLocation, AssetHolder, AssetLog, AssetStatus, AssetSchedule, AssetScheduleAsset, AssetScheduleUser, Handover, HandoverItem, HandoverStockItem, HandoverCustomItem, HandoverField, Inventory, InventoryLabel, InventoryVariant, InventoryStockBalance, InventoryStockOut, InventoryStockOutItem, InventoryStockTransfer, InventoryStockTransferItem, InventoryStockIn, InventoryStockInItem, InventoryStockOpname, InventoryStockOpnameItem, InventoryLog, Role, Permission, PasswordResetToken, Organization, Job, FailedJob, Transfer],
    migrations: [],
    subscribers: [],
})

let activeDataSource: DataSource = defaultDataSource

/** Get the active DataSource (default or test-overridden) */
export function getDataSource(): DataSource {
    return activeDataSource
}

/** Override DataSource for testing */
export function setDataSource(ds: DataSource): void {
    activeDataSource = ds
}

/** Reset to default DataSource */
export function resetDataSource(): void {
    activeDataSource = defaultDataSource
}

/**
 * Backward-compatible export.
 * Modules yang sudah import `AppDataSource` tetap bekerja.
 * Proxy mendelegasikan semua akses ke activeDataSource.
 */
export const AppDataSource = new Proxy({} as DataSource, {
    get(_target, prop: string | symbol) {
        const value = (activeDataSource as any)[prop]
        // Bind methods ke DataSource asli agar `this` benar
        if (typeof value === "function") {
            return value.bind(activeDataSource)
        }
        return value
    },
})
