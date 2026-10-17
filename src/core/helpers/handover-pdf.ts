import { PDFDocument, StandardFonts, rgb, PDFFont, PDFPage } from "pdf-lib"
import type { Handover } from "../../modules/handover/entities/handover.entity"
import type { HandoverTransactionType } from "../enums"

const A4 = { w: 595.28, h: 841.89 }
const MARGIN = 40
const LEFT = MARGIN
const RIGHT = A4.w - MARGIN
const CONTENT_W = RIGHT - LEFT
const BORDER = rgb(0, 0, 0)

type Line = { text: string; checkbox?: boolean; checked?: boolean; bold?: boolean }

/**
 * The "Nama Karyawan" shown on the form: for Penetapan (assign) it's the employee receiving
 * the item; for Pengembalian (return) it's the employee handing it back.
 */
export function resolveEmployeeName(handover: Pick<Handover, "transactionType" | "receivedBy" | "handedOverBy">): string {
    const tt = handover.transactionType as HandoverTransactionType
    return (tt === "return" ? handover.handedOverBy?.name : handover.receivedBy?.name) ?? "-"
}

function formatDate(value?: string | Date | null): string {
    if (!value) return "-"
    const d = new Date(value)
    if (isNaN(d.getTime())) return String(value)
    const dd = String(d.getDate()).padStart(2, "0")
    const mm = String(d.getMonth() + 1).padStart(2, "0")
    const yyyy = d.getFullYear()
    return `${dd}-${mm}-${yyyy}`
}

/**
 * Strip control characters (e.g. stray bytes from bad imports/synced data) that pdf-lib's
 * WinAnsi font encoding cannot represent — drawing them throws "WinAnsi cannot encode ...".
 * \t, \n, \r are kept since the whitespace handling below deals with them separately.
 */
function sanitizeText(value: string): string {
    return value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
}

function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
    const clean = sanitizeText((text ?? "").toString()).replace(/\r?\n/g, " ").trim()
    if (!clean) return [""]
    const words = clean.split(/\s+/)
    const lines: string[] = []
    let current = ""
    for (const word of words) {
        const candidate = current ? `${current} ${word}` : word
        if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
            current = candidate
        } else {
            if (current) lines.push(current)
            // Hard-break a single word that is too long
            if (font.widthOfTextAtSize(word, size) > maxWidth) {
                let chunk = ""
                for (const ch of word) {
                    if (font.widthOfTextAtSize(chunk + ch, size) > maxWidth) {
                        lines.push(chunk)
                        chunk = ch
                    } else {
                        chunk += ch
                    }
                }
                current = chunk
            } else {
                current = word
            }
        }
    }
    if (current) lines.push(current)
    return lines.length ? lines : [""]
}

/**
 * Generate the "FORM SERAH TERIMA ASET/BARANG" PDF for a handover.
 * Returns the raw PDF bytes.
 */
export async function generateHandoverPdf(handover: Handover): Promise<Uint8Array> {
    const doc = await PDFDocument.create()
    const page = doc.addPage([A4.w, A4.h])
    const font = await doc.embedFont(StandardFonts.Helvetica)
    const fontBold = await doc.embedFont(StandardFonts.HelveticaBold)

    const drawText = (
        text: string,
        x: number,
        baseline: number,
        size: number,
        f: PDFFont = font
    ) => page.drawText(text, { x, y: baseline, size, font: f, color: rgb(0, 0, 0) })

    const cell = (x: number, top: number, w: number, h: number) =>
        page.drawRectangle({ x, y: top - h, width: w, height: h, borderColor: BORDER, borderWidth: 0.7 })

    const title = "FORM SERAH TERIMA ASET/BARANG"
    const titleSize = 13
    const titleW = fontBold.widthOfTextAtSize(title, titleSize)
    const titleX = (A4.w - titleW) / 2
    let y = A4.h - 45
    drawText(title, titleX, y, titleSize, fontBold)
    page.drawLine({
        start: { x: titleX, y: y - 3 },
        end: { x: titleX + titleW, y: y - 3 },
        thickness: 0.8,
        color: BORDER,
    })

    y -= 35

    const tt = handover.transactionType as HandoverTransactionType
    const employeeName = resolveEmployeeName(handover)

    const infoRows: { label: string; lines: Line[] }[] = [
        { label: "Tanggal", lines: [{ text: formatDate(handover.createdAt) }] },
        { label: "Nama Karyawan", lines: [{ text: employeeName }] },
        {
            label: "Type",
            lines: [
                { text: "Penetapan", checkbox: true, checked: tt === "assign", bold: true },
                { text: "Pengembalian", checkbox: true, checked: tt === "return", bold: true },
            ],
        },
        { label: "Catatan", lines: [{ text: handover.note || "-" }] },
        // Snapshotted custom fields (label : value)
        ...(handover.customFields || []).map((f) => ({ label: f.label, lines: [{ text: f.value || "-" }] })),
    ]

    const labelW = 175
    const valueW = CONTENT_W - labelW
    const size = 10
    const lineH = 18
    const padV = 6

    for (const row of infoRows) {
        // Expand each logical line into wrapped visual lines (checkbox lines stay single).
        const visual: { text: string; checkbox?: boolean; checked?: boolean; bold?: boolean }[] = []
        for (const line of row.lines) {
            if (line.checkbox) {
                visual.push(line)
            } else {
                const wrapped = wrapText(line.text, line.bold ? fontBold : font, size, valueW - 16)
                wrapped.forEach((t) => visual.push({ text: t, bold: line.bold }))
            }
        }

        const h = visual.length * lineH + 2 * padV - (lineH - 12)
        cell(LEFT, y, labelW, h)
        cell(LEFT + labelW, y, valueW, h)

        drawText(sanitizeText(row.label), LEFT + 6, y - padV - size, size, font)

        let baseY = y - padV - size
        for (const line of visual) {
            let tx = LEFT + labelW + 8
            if (line.checkbox) {
                page.drawRectangle({ x: tx, y: baseY - 1, width: 10, height: 10, borderColor: BORDER, borderWidth: 0.7 })
                if (line.checked) drawText("X", tx + 2, baseY + 0.5, 9, fontBold)
                tx += 16
            }
            drawText(line.text, tx, baseY, size, line.bold ? fontBold : font)
            baseY -= lineH
        }

        y -= h
    }

    y -= 22
    drawText("Telah diserahkan asset/barang berupa :", LEFT, y, size, font)
    y -= 12

    const conditionLabel = (c: string) => (c === "new" ? "Baru" : c === "used" ? "Bekas" : c)
    const cols = [
        { title: "No.", w: 30 },
        { title: "Nama Barang", w: 150 },
        { title: "Code", w: 90 },
        { title: "Jumlah", w: 70 },
        { title: "Keterangan", w: CONTENT_W - 30 - 150 - 90 - 70 },
    ]
    const colX: number[] = []
    let cx = LEFT
    for (const c of cols) {
        colX.push(cx)
        cx += c.w
    }

    const headerH = 24
    cx = LEFT
    for (const c of cols) {
        cell(cx, y, c.w, headerH)
        const tw = fontBold.widthOfTextAtSize(c.title, size)
        drawText(c.title, cx + (c.w - tw) / 2, y - headerH / 2 - size / 2 + 2, size, fontBold)
        cx += c.w
    }
    y -= headerH

    // Normalize asset + stock lines into one common {name, code, jumlah, note} shape for one table.
    const assetRows = (handover.items ?? []).map((item) => ({
        name: item.asset?.name ?? "-",
        code: item.asset?.code ?? "-",
        jumlah: "1",
        note: item.note || "-",
    }))
    const stockRows = (handover.stockItems ?? []).map((item) => {
        const inventoryName = item.variant?.inventory?.name ?? "-"
        const variantName = item.variant?.name ? ` - ${item.variant.name}` : ""
        const unit = item.variant?.inventory?.unit ? ` ${item.variant.inventory.unit}` : ""
        const branch = item.branch?.name ? `Cabang: ${item.branch.name}` : ""
        return {
            name: `${inventoryName}${variantName} (${conditionLabel(item.condition)})`,
            code: item.variant?.code || "-",
            jumlah: `${item.quantity}${unit}`,
            note: [branch, item.note || ""].filter(Boolean).join(" — ") || "-",
        }
    })
    const customRows = (handover.customItems ?? []).map((item) => ({
        name: item.name,
        code: item.code || "-",
        jumlah: `${item.quantity}${item.unit ? ` ${item.unit}` : ""}`,
        note: item.note || "-",
    }))
    const rows = [...assetRows, ...stockRows, ...customRows]

    rows.forEach((item, idx) => {
        const no = String(idx + 1)
        const name = item.name
        const code = item.code
        const jumlah = item.jumlah
        const note = item.note

        const nameLines = wrapText(name, font, size, cols[1].w - 12)
        const codeLines = wrapText(code, font, size, cols[2].w - 12)
        const jumlahLines = wrapText(jumlah, font, size, cols[3].w - 12)
        const descLines = wrapText(note, font, size, cols[4].w - 12)
        const maxLines = Math.max(nameLines.length, codeLines.length, jumlahLines.length, descLines.length, 1)
        const rowH = maxLines * (lineH - 4) + 8

        cx = LEFT
        for (const c of cols) {
            cell(cx, y, c.w, rowH)
            cx += c.w
        }

        const cellTop = y - 6 - size + 2
        drawText(no, colX[0] + (cols[0].w - font.widthOfTextAtSize(no, size)) / 2, cellTop, size, font)
        nameLines.forEach((l, i) => drawText(l, colX[1] + 6, cellTop - i * (lineH - 4), size, font))
        codeLines.forEach((l, i) => drawText(l, colX[2] + 6, cellTop - i * (lineH - 4), size, font))
        jumlahLines.forEach((l, i) => drawText(l, colX[3] + 6, cellTop - i * (lineH - 4), size, font))
        descLines.forEach((l, i) => drawText(l, colX[4] + 6, cellTop - i * (lineH - 4), size, font))

        y -= rowH
    })

    y -= 30
    const halfW = CONTENT_W / 2
    const sigHeaderH = 24
    const sigBodyH = 95

    const menyerahkanName = sanitizeText(handover.handedOverBy?.name ?? "")
    const menerimaName = sanitizeText(handover.receivedBy?.name ?? "")

    const sig = (x: number, header: string, name: string) => {
        cell(x, y, halfW, sigHeaderH)
        const hw = fontBold.widthOfTextAtSize(header, size)
        drawText(header, x + (halfW - hw) / 2, y - sigHeaderH / 2 - size / 2 + 2, size, fontBold)

        cell(x, y - sigHeaderH, halfW, sigBodyH)
        const nameW = font.widthOfTextAtSize(name, size)
        drawText(name, x + (halfW - nameW) / 2, y - sigHeaderH - sigBodyH + 10, size, font)
    }

    sig(LEFT, "Yang Menyerahkan,", menyerahkanName)
    sig(LEFT + halfW, "Yang Menerima,", menerimaName)

    y -= sigHeaderH + sigBodyH + 14
    drawText("*Diisi narasi keterangan/kondisi barang yang diterima", LEFT, y, 8, font)

    return await doc.save()
}
