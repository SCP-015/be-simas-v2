import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    CreateDateColumn,
    UpdateDateColumn,
    ManyToOne,
    JoinColumn,
    Index,
} from "typeorm"
import type { Relation } from "typeorm"

import { Asset } from "../../asset/entities/asset.entity"
import { Employee } from "../../employee/entities/employee.entity"
import { Organization } from "../../organization/entities/organization.entity"
import { User } from "../../user/entities/user.entity"
import { Handover } from "../../handover/entities/handover.entity"
import type { AssetHolderKind } from "../../../core/enums"

@Entity("asset_holders")
export class AssetHolder {
    @PrimaryGeneratedColumn()
    id!: number

    @Index()
    @Column({ name: "asset_id" })
    assetId!: number

    @ManyToOne(() => Asset, { onDelete: "RESTRICT" })
    @JoinColumn({ name: "asset_id" })
    asset!: Relation<Asset>

    /** Matches whichever of employeeId/organizationId is set. */
    @Column({ name: "holder_kind", type: "varchar", default: "employee" })
    holderKind!: AssetHolderKind

    @Index()
    @Column({ name: "employee_id", nullable: true })
    employeeId?: number | null

    @ManyToOne(() => Employee, { onDelete: "RESTRICT", nullable: true })
    @JoinColumn({ name: "employee_id" })
    employee?: Relation<Employee> | null

    @Index()
    @Column({ name: "organization_id", nullable: true })
    organizationId?: number | null

    @ManyToOne(() => Organization, { onDelete: "RESTRICT", nullable: true })
    @JoinColumn({ name: "organization_id" })
    organization?: Relation<Organization> | null

    @Column({ name: "assigned_date", type: "varchar" })
    assignedDate!: string

    @Index()
    @Column({ name: "returned_date", type: "varchar", nullable: true })
    returnedDate?: string | null

    @Column({ name: "assign_note", type: "text", nullable: true })
    assignNote?: string | null

    @Column({ name: "return_note", type: "text", nullable: true })
    returnNote?: string | null

    @Column({ name: "created_by", nullable: true })
    createdByUserId?: number | null

    @ManyToOne(() => User, { onDelete: "SET NULL", nullable: true })
    @JoinColumn({ name: "created_by" })
    createdBy?: Relation<User> | null

    @Column({ name: "returned_by", nullable: true })
    returnedByUserId?: number | null

    @ManyToOne(() => User, { onDelete: "SET NULL", nullable: true })
    @JoinColumn({ name: "returned_by" })
    returnedBy?: Relation<User> | null

    @Index()
    @Column({ name: "assign_handover_id", nullable: true })
    assignHandoverId?: number | null

    @ManyToOne(() => Handover, { onDelete: "SET NULL", nullable: true })
    @JoinColumn({ name: "assign_handover_id" })
    assignHandover?: Relation<Handover> | null

    @Index()
    @Column({ name: "return_handover_id", nullable: true })
    returnHandoverId?: number | null

    @ManyToOne(() => Handover, { onDelete: "SET NULL", nullable: true })
    @JoinColumn({ name: "return_handover_id" })
    returnHandover?: Relation<Handover> | null

    /** Nusawork note `id_group`, returned when the note was created at assign time. */
    @Index()
    @Column({
        name: "nusawork_group_id",
        type: "bigint",
        nullable: true,
        transformer: {
            to: (value: number | null | undefined) => value,
            from: (value: string | number | null | undefined) => (value != null ? Number(value) : null),
        },
    })
    nusaworkGroupId?: number | null

    @CreateDateColumn({ name: "created_at" })
    createdAt!: Date

    @UpdateDateColumn({ name: "updated_at" })
    updatedAt!: Date
}