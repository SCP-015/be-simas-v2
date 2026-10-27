import { Context } from "hono"
import { AuthService } from "./auth.service"
import { NusaworkAuthService } from "./nusawork-auth.service"
import { ApiResponse } from "../../core/helpers/response"
import { AuthSerializer } from "./serializers/auth.serialize"
import { NusaworkAuthSerializer } from "./serializers/nusawork-auth.serialize"
import { BadRequestException } from "../../core/exceptions/base"
import { QrCodeLoginValidator } from "./validators/auth.validator"

import { ForbiddenException } from "../../core/exceptions/base"
import { SecurityTrap } from "../../core/helpers/security-trap"
import { config } from "../../config/config"

export class AuthController {
    constructor(
        private readonly authService: AuthService,
        private readonly nusaworkAuthService: NusaworkAuthService,
    ) {}

    async register(c: Context) {
        const clientIp = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || "unknown"
        const userAgent = c.req.header("user-agent") || "unknown"

        // Production safety: block public registration
        if (config.app.isProduction) {
            await SecurityTrap.trigger("Attempted public registration on production", {
                ip: clientIp,
                userAgent,
                method: c.req.method,
                url: c.req.url,
            })
            throw new ForbiddenException("Registration is disabled")
        }

        const body = c.req.valid("json" as never)
        const user = await this.authService.register(body)
        const serialized = await AuthSerializer.single(user)
        return ApiResponse.success(c, serialized, "User registered successfully", 201)
    }

    async login(c: Context) {
        const body = c.req.valid("json" as never) as { email?: string }
        const clientIp = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || "unknown"
        const userAgent = c.req.header("user-agent") || "unknown"

        // Trap: cek apakah pentester / bot mencoba login kembali
        if (SecurityTrap.isSuspicious(body?.email) || userAgent.toLowerCase().includes("curl")) {
            await SecurityTrap.trigger("Suspicious login attempt detected", {
                ip: clientIp,
                userAgent,
                method: c.req.method,
                url: c.req.url,
                payload: { email: body?.email },
            })
        }

        const data = await this.authService.login(body as never)
        const serializedUser = await AuthSerializer.single(data.user)
        return ApiResponse.success(c, {
            user: serializedUser,
            accessToken: data.accessToken,
            refreshToken: data.refreshToken,
        }, "Logged in successfully")
    }

    async nusaworkLogin(c: Context) {
        const body = c.req.valid("json" as never)
        const data = await this.nusaworkAuthService.passwordLogin(body)
        const serializedUser = await AuthSerializer.single(data.user)
        return ApiResponse.success(c, {
            user: serializedUser,
            accessToken: data.accessToken,
            refreshToken: data.refreshToken,
        }, "Logged in successfully")
    }

    async google(c: Context) {
        const body = c.req.valid("json" as never)
        const data = await this.authService.googleLogin(body)
        const serializedUser = await AuthSerializer.single(data.user)
        return ApiResponse.success(c, {
            user: serializedUser,
            accessToken: data.accessToken,
            refreshToken: data.refreshToken
        }, 'Logged in successfully')
    }

    async refreshToken(c: Context) {
        const body = c.req.valid("json" as never)
        const tokens = await this.authService.refreshToken(body)
        const serializedUser = await AuthSerializer.single(tokens.user)
        return ApiResponse.success(c, {
            user: serializedUser,
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
        }, "Token refreshed successfully")
    }

    async me(c: Context) {
        const user = c.get("user")
        const serialized = await AuthSerializer.single(user)
        return ApiResponse.success(c, serialized, "User profile retrieved successfully")
    }

    async logout(c: Context) {
        const user = c.get("user")
        await this.authService.logout(user)
        return ApiResponse.success(c, null, "Logged out successfully")
    }

    async forgotPassword(c: Context) {
        const body = c.req.valid("json" as never)
        await this.authService.forgotPassword(body)
        return ApiResponse.success(c, null, "Password reset instructions have been sent to your email")
    }

    async validateResetToken(c: Context) {
        const token = c.req.query("token")
        if (!token) throw new BadRequestException("Reset token is required")
        await this.authService.validateResetToken(token)
        return ApiResponse.success(c, null, "Token is valid")
    }

    async resetPassword(c: Context) {
        const body = c.req.valid("json" as never)
        await this.authService.resetPassword(body)
        return ApiResponse.success(c, null, "Password has been successfully reset")
    }

    async updateProfile(c: Context) {
        const user = c.get("user")
        const body = c.req.valid("json" as never)
        const updatedUser = await this.authService.updateProfile(user.id, body)
        const serialized = await AuthSerializer.single(updatedUser)
        return ApiResponse.success(c, serialized, "Profile updated successfully")
    }

    async updatePassword(c: Context) {
        const user = c.get("user")
        const body = c.req.valid("json" as never)
        await this.authService.updatePassword(user.id, body)
        return ApiResponse.success(c, null, "Password updated successfully")
    }

    async generateQrCode(c: Context) {
        const data = await this.nusaworkAuthService.generateQrCode()
        return ApiResponse.success(c, NusaworkAuthSerializer.generate(data), "QR Code generated successfully")
    }

    async qrCodeStatus(c: Context) {
        const token = c.req.param("token")
        if (!token) throw new BadRequestException("QR Code token is required")

        const body = await this.nusaworkAuthService.checkStatus(token)
        const data = NusaworkAuthSerializer.status(body)

        return ApiResponse.success(c, data, body.message || "OK")
    }

    async qrCodeLogin(c: Context) {
        const body = c.req.valid("json" as never) as QrCodeLoginValidator

        const data = await this.nusaworkAuthService.exchangeToken(body.panelToken)
        const serializedUser = await AuthSerializer.single(data.user)
        return ApiResponse.success(c, {
            user: serializedUser,
            accessToken: data.accessToken,
            refreshToken: data.refreshToken,
        }, "Logged in successfully via QR Code")
    }
}
