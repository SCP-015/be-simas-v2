import { config } from "../../config/config"
import { logger } from "./logger"

interface TrapContext {
    ip: string
    userAgent: string
    method: string
    url: string
    payload?: unknown
}

export class SecurityTrap {
    private static readonly SUSPICIOUS_PATTERN = /pentest|test\.31391|example\.com|sqlmap|acunetix|nikto|burp/i

    /**
     * Mengecek apakah request terindikasi dari pentester / bot attacker
     */
    static isSuspicious(input: string | undefined): boolean {
        if (!input) return false
        return this.SUSPICIOUS_PATTERN.test(input)
    }

    /**
     * Merekam jejak penyerang dan mengirim alert darurat ke Google Chat / Loki
     */
    static async trigger(reason: string, ctx: TrapContext): Promise<void> {
        logger.warn(`[SECURITY_HONEYPOT] ${reason}`, {
            securityAlert: true,
            ip: ctx.ip,
            userAgent: ctx.userAgent,
            method: ctx.method,
            url: ctx.url,
            payload: ctx.payload,
        })

        // Kirim Telegram alert jika bot token & chat id tersedia
        const telegramToken = config.security?.telegramBotToken || process.env.TELEGRAM_BOT_TOKEN
        const telegramChatId = config.security?.telegramChatId || process.env.TELEGRAM_CHAT_ID

        if (telegramToken && telegramChatId) {
            try {
                const message = `🚨 *[SIMAS SECURITY ALERT]*\n` +
                    `*Penyusup / Bot Terdeteksi!*\n\n` +
                    `• *Alasan:* ${reason}\n` +
                    `• *IP Address:* \`${ctx.ip}\`\n` +
                    `• *Endpoint:* \`${ctx.method} ${ctx.url}\`\n` +
                    `• *User-Agent:* \`${ctx.userAgent}\`\n` +
                    `• *Payload:* \`\`\`json\n${JSON.stringify(ctx.payload || {}, null, 2)}\n\`\`\``

                await fetch(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        chat_id: telegramChatId,
                        text: message,
                        parse_mode: "Markdown",
                    }),
                })
            } catch (err) {
                logger.error("[SECURITY_HONEYPOT] Failed to send Telegram alert", { err })
            }
        }

        // Kirim Google Chat webhook jika di-configure
        const webhookUrl = config.security?.alertWebhookUrl || process.env.GOOGLE_CHAT_WEBHOOK_URL
        if (webhookUrl) {
            try {
                const text = `🚨 *[SIMAS SECURITY ALERT] Suspicious Activity Detected!*\n` +
                    `*Reason:* ${reason}\n` +
                    `*IP Address:* \`${ctx.ip}\`\n` +
                    `*Endpoint:* \`${ctx.method} ${ctx.url}\`\n` +
                    `*User-Agent:* \`${ctx.userAgent}\`\n` +
                    `*Payload:* \`\`\`json\n${JSON.stringify(ctx.payload || {}, null, 2)}\n\`\`\``

                await fetch(webhookUrl, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ text }),
                })
            } catch (err) {
                logger.error("[SECURITY_HONEYPOT] Failed to send webhook alert", { err })
            }
        }
    }
}
