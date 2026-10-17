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
import { Handover } from "./handover.entity"

@Entity("handover_custom_items")
export class HandoverCustomItem {
    @PrimaryGeneratedColumn()
    id!: number

    @Index()
    @Column({ name: "handover_id" })
    handoverId!: number

    @ManyToOne(() => Handover, (handover) => handover.customItems, {
        onDelete: "CASCADE",
    })
    @JoinColumn({ name: "handover_id" })
    handover!: Relation<Handover>

    @Column({ type: "varchar" })
    name!: string

    @Column({ type: "varchar", nullable: true })
    code?: string | null

    @Column({ type: "integer" })
    quantity!: number

    @Column({ type: "varchar", nullable: true })
    unit?: string | null

    @Column({ type: "text", nullable: true })
    note?: string | null

    @CreateDateColumn({ name: "created_at" })
    createdAt!: Date

    @UpdateDateColumn({ name: "updated_at" })
    updatedAt!: Date
}
