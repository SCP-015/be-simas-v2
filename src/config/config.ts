/**
 * Global Application Configuration
 * All environment variables are centralized here
 * 
 * PRODUCTION SAFETY:
 * - JWT secrets WAJIB di-set via environment variable di production
 * - DB_SYNC otomatis false di production (mencegah data loss)
 */

const env = process.env.NODE_ENV || 'development'
const isProduction = env === 'production'

/**
 * Validate required env vars in production.
 * Akan crash saat startup jika env penting tidak di-set.
 */
function requireEnv(key: string, defaultValue?: string): string {
    const value = process.env[key] || defaultValue
    if (!value && isProduction) {
        throw new Error(`[CONFIG] Missing required environment variable: ${key}`)
    }
    return value || ''
}

export const config = {
    app: {
        port: Number(process.env.PORT) || 3000,
        appUrl: process.env.APP_URL || 'http://localhost:4000',
        env,
        isProduction,
        jwtSecret: requireEnv('JWT_SECRET', isProduction ? undefined : 'dev-jwt-secret-change-me'),
        jwtRefreshSecret: requireEnv('JWT_REFRESH_SECRET', isProduction ? undefined : 'dev-jwt-refresh-secret-change-me'),
        apiKey: requireEnv('API_KEY', isProduction ? undefined : 'dev-api-key-change-me'),
        corsOrigins: process.env.CORS_ORIGINS
            ? process.env.CORS_ORIGINS.split(',').map(s => s.trim())
            : (isProduction ? [] : ['*']),
    },
    database: {
        type: (process.env.DB_TYPE || 'postgres') as 'postgres' | 'mysql',
        host: process.env.DB_HOST || '127.0.0.1',
        port: Number(process.env.DB_PORT) || 5432,
        user: process.env.DB_USER || 'root',
        pass: process.env.DB_PASS || '',
        name: process.env.DB_NAME || 'simas',
        // SAFETY: synchronize SELALU false di production (gunakan migrations)
        sync: isProduction ? false : process.env.DB_SYNC === "true",
    },
    mail: {
        host: process.env.SMTP_HOST || 'smtp.gmail.com',
        port: Number(process.env.SMTP_PORT) || 587,
        user: process.env.SMTP_USER || '',
        pass: process.env.SMTP_PASS || '',
        from: process.env.SMTP_FROM || '"SIMAS" <noreply@example.com>',
    },
    google: {
        clientId: process.env.GOOGLE_CLIENT_ID || '',
        clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    },
    minio: {
        endPoint: process.env.MINIO_ENDPOINT || '127.0.0.1',
        port: Number(process.env.MINIO_PORT) || 9000,
        useSSL: process.env.MINIO_USE_SSL === 'true',
        accessKey: process.env.MINIO_ACCESS_KEY || '',
        secretKey: process.env.MINIO_SECRET_KEY || '',
        bucket: process.env.MINIO_BUCKET || 'simas-be',
    },
    feedback: {
        scriptUrl: process.env.FEEDBACK_URL || '',
    },
    mist: {
        webhookSecret: process.env.MIST_WEBHOOK_SECRET || '',
    },
    nusawork: {
        apiUrl: process.env.NUSAWORK_API_URL || '',
        clientId: process.env.NUSAWORK_CLIENT_ID || '',
        clientSecret: process.env.NUSAWORK_CLIENT_SECRET || '',
        auth: {
            clientId: process.env.NUSAWORK_AUTH_CLIENT_ID || '',
            clientSecret: process.env.NUSAWORK_AUTH_CLIENT_SECRET || '',
        }
    },
    esign: {
        apiUrl: process.env.ESIGN_API_URL || '',
        clientId: process.env.ESIGN_CLIENT_ID || '',
        clientSecret: process.env.ESIGN_CLIENT_SECRET || '',
        tenantSlug: process.env.ESIGN_TENANT_SLUG || 'nusawork',
    },
    gemini: {
        apiKey: process.env.GEMINI_API_KEY || '',
        model: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
    },
    logging: {
        toFile: process.env.LOG_TO_FILE !== 'false',
        jobName: process.env.JOB_NAME || undefined,
    },
    security: {
        alertWebhookUrl: process.env.GOOGLE_CHAT_WEBHOOK_URL || '',
        telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
        telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
    },
}
