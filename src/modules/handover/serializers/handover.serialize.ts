import { Handover } from "../entities/handover.entity"
import { HandoverItem } from "../entities/handover-item.entity"
import { HandoverStockItem } from "../entities/handover-stock-item.entity"
import { HandoverCustomItem } from "../entities/handover-custom-item.entity"
import { resolveFileUrl } from "../../../core/helpers/serializer-utils"
import { Attachment } from "../../attachment/entities/attachment.entity"
import { AttachmentSerializer } from "../../attachment/serializers/attachment.serialize"

export class HandoverSerializer {

    private static async item(item: HandoverItem) {
        return {
            id: item.id,
            note: item.note || null,
            asset: item.asset ? {
                id: item.asset.id,
                name: item.asset.name,
                code: item.asset.code,
                image: await resolveFileUrl(item.asset.image),
            } : null,
        }
    }

    private static stockItem(item: HandoverStockItem) {
        return {
            id: item.id,
            condition: item.condition,
            quantity: item.quantity,
            note: item.note || null,
            branch: item.branch ? { id: item.branch.id, name: item.branch.name } : null,
            variant: item.variant ? {
                id: item.variant.id,
                name: item.variant.name,
                code: item.variant.code || null,
                unit: item.variant.inventory?.unit ?? "",
                inventory: item.variant.inventory ? { id: item.variant.inventory.id, name: item.variant.inventory.name, code: item.variant.inventory.code || null } : null,
            } : null,
        }
    }

    private static customItem(item: HandoverCustomItem) {
        return {
            id: item.id,
            name: item.name,
            code: item.code || null,
            quantity: item.quantity,
            unit: item.unit || null,
            note: item.note || null,
        }
    }

    static async single(handover: Handover, attachments: Attachment[] = []) {
        return {
            id: handover.id,
            received: handover.receivedBy ? {
                id: handover.receivedBy.id,
                name: handover.receivedBy.name,
                employeeId: handover.receivedBy.employeeId,
                jobPosition: handover.receivedBy.jobPosition,
                photo: await resolveFileUrl(handover.receivedBy.photo),
            } : null,
            handedOver: handover.handedOverBy ? {
                id: handover.handedOverBy.id,
                name: handover.handedOverBy.name,
                employeeId: handover.handedOverBy.employeeId,
                jobPosition: handover.handedOverBy.jobPosition,
                photo: await resolveFileUrl(handover.handedOverBy.photo),
            } : null,
            status: handover.status,
            transactionType: handover.transactionType,
            date: handover.date || null,
            note: handover.note || null,
            customFields: handover.customFields || [],
            parentHandover: handover.parentHandover ? {
                id: handover.parentHandover.id,
                transactionType: handover.parentHandover.transactionType,
                status: handover.parentHandover.status,
            } : null,
            createdAt: handover.createdAt,
            updatedAt: handover.updatedAt,
            createdBy: handover.createdBy ? {
                id: handover.createdBy.id,
                name: handover.createdBy.name,
                photo: await resolveFileUrl(handover.createdBy.photo),
            } : null,
            attachments: await AttachmentSerializer.collection(attachments),
            items: await Promise.all((handover.items || []).map((item) => this.item(item))),
            stockItems: (handover.stockItems || []).map((item) => this.stockItem(item)),
            customItems: (handover.customItems || []).map((item) => this.customItem(item)),
        }
    }

    static async collection(items: { handover: Handover; attachments: Attachment[] }[]) {
        return Promise.all(items.map((i) => this.single(i.handover, i.attachments)))
    }
}
