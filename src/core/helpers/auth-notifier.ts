import { config } from "../../config/config"
import { logger } from "./logger"

interface AuthLogContext {
    ip: string
    userAgent: string
    method?: string
    url?: string
    email?: string
    userId?: number | string
    name?: string
    loginMethod: "PASSWORD" | "NUSAWORK" | "GOOGLE" | "QRCODE" | "REGISTER"
    status: "SUCCESS" | "SUSPICIOUS" | "FAILED"
    reason?: string
}

export class AuthNotifier {
    // Whitelist domain resmi yang diperbolehkan login
    private static readonly ALLOWED_DOMAINS = ["nusa.id", "nusanet.id", "gmail.com"]

    static isAllowedDomain(email: string | undefined): boolean {
        if (!email || !email.includes("@")) return false
        const domain = email.split("@")[1].toLowerCase().trim()
        return this.ALLOWED_DOMAINS.includes(domain)
    }

    static isSuspiciousRequest(email: string | undefined, userAgent: string | undefined): boolean {
        if (!email) return true
        if (!this.isAllowedDomain(email)) return true
        
        const ua = (userAgent || "").toLowerCase()
        if (ua.includes("curl") || ua.includes("sqlmap") || ua.includes("burp") || ua.includes("nikto") || ua.includes("python-requests")) {
            return true
        }
        return false
    }

    static async notify(ctx: AuthLogContext): Promise<void> {
        const envLabel = config.app.isProduction ? "PROD" : "DEV"
        const isAlert = ctx.status === "SUSPICIOUS" || ctx.status === "FAILED"

        logger.info(`[AUTH_LOG] [${envLabel}] ${ctx.loginMethod} - ${ctx.status}`, {
            ...ctx,
            env: envLabel,
        })

        const telegramToken = config.security?.telegramBotToken || process.env.TELEGRAM_BOT_TOKEN
        const telegramChatId = config.security?.telegramChatId || process.env.TELEGRAM_CHAT_ID

        if (telegramToken && telegramChatId) {
            try {
                let message = ""
                if (isAlert) {
                    message = `🚨 *[SIMAS ${envLabel} - SUSPICIOUS LOGIN]*\n\n` +
                        `• *Status:* ⚠️ ${ctx.status}\n` +
                        `• *Metode:* ${ctx.loginMethod}\n` +
                        `• *Email:* \`${ctx.email || "-"}\`\n` +
                        `• *Alasan:* ${ctx.reason || "Domain tidak diizinkan / bot tool"}\n` +
                        `• *IP:* \`${ctx.ip}\`\n` +
                        `• *User-Agent:* \`${ctx.userAgent}\``
                } else {
                    message = `🔑 *[SIMAS ${envLabel} - USER LOGIN]*\n\n` +
                        `• *Status:* ✅ ${ctx.status}\n` +
                        `• *User:* ${ctx.name || "-"} (ID: ${ctx.userId || "-"})\n` +
                        `• *Email:* \`${ctx.email || "-"}\`\n` +
                        `• *Metode:* ${ctx.loginMethod}\n` +
                        `• *IP:* \`${ctx.ip}\``
                }

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
                logger.error("[AUTH_NOTIFIER] Gagal kirim Telegram", { err })
            }
        }
    }
}
