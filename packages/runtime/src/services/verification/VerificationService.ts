import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { type Context as PluxelContext, RootService } from '@pluxel/core'
import { recordSecurityEvent } from '../security/audit'
import {
	readSecurityIdentitySync,
	updateSecurityIdentity,
} from '../security/identity'
import {
	deleteVerificationUser,
	findOtpUser,
	findPasskeyUser,
	findPasswordUser,
	listVerificationUsers,
	normalizeOtpCode,
	normalizeVerificationUsername,
	requireVerificationPassword,
	resolveVerificationConfig,
	setVerificationConfigMethod,
	setVerificationConfigMode,
	upsertOtpUser,
	upsertPasskeyUser,
	upsertPasswordUser,
} from './model'
import { buildOtpAuthUrl, generateOtpSecret, verifyTotpCode } from './otp'
import {
	buildPasskeyAuthenticationOptions,
	buildPasskeyRegistrationOptions,
	verifyPasskeyAuthentication,
	verifyPasskeyRegistration,
} from './passkey'
import {
	b64url,
	b64urlDecode,
	hashPasswordScrypt,
	verifyPasswordScrypt,
} from './password'
import {
	VERIFICATION_COOKIE_NAME,
	VERIFICATION_SESSION_TTL_MS,
} from './transport'
import type {
	VerificationAdminState,
	VerificationAuthorizeInput,
	VerificationConfig,
	VerificationMethod,
	VerificationMode,
	VerificationOtpProvisionResult,
	VerificationOtpUserProvisionInput,
	VerificationOtpVerifyInput,
	VerificationPasskeyAuthenticationFinishInput,
	VerificationPasskeyAuthenticationOptions,
	VerificationPasskeyAuthenticationStartInput,
	VerificationPasskeyRegistrationFinishInput,
	VerificationPasskeyRegistrationOptions,
	VerificationPasskeyRegistrationStartInput,
	VerificationPasswordUserUpsertInput,
	VerificationPasswordVerifyInput,
	VerificationState,
	VerificationUserDeleteInput,
	VerificationVerifyResult,
} from './types'

const serviceName = 'verification' as const
const OTP_ISSUER = 'Pluxel'

type SessionPayload = {
	verified: true
	sub: string
	iat: number
	exp: number
	v: string
}

type PendingPasskeyChallenge = {
	challenge: string
	origin: string
	rpId: string
}

type VerificationRuntimeState = {
	secret: string
	revokedAfter?: number
	passkeyRegistration: Map<string, PendingPasskeyChallenge>
	passkeyAuthentication: Map<string, PendingPasskeyChallenge>
}

type VerificationRuntime = {
	config: VerificationConfig
	version: string
	state: VerificationRuntimeState
}

type VerificationAccess = {
	now: number
	headers?: Headers
	cookieSession?: SessionPayload | null
}

const STATE_SYMBOL = Symbol.for('pluxel:runtime:verification-state')

declare module '@pluxel/core' {
	namespace Context {
		interface RootServices {
			[serviceName]: VerificationService
		}
	}
}

function parseCookie(header: string | null | undefined, key: string): string | undefined {
	if (!header) return undefined
	const parts = header.split(';')
	for (const part of parts) {
		const [name, ...rest] = part.trim().split('=')
		if (!name || name !== key) continue
		return rest.join('=') || undefined
	}
	return undefined
}

function isSecureRequest(url: string | undefined, headers: Headers): boolean {
	const forwarded = headers.get('x-forwarded-proto')
	if (forwarded) {
		const first = forwarded.split(',')[0]?.trim().toLowerCase()
		if (first === 'https') return true
	}
	if (!url) return false
	try {
		return new URL(url).protocol === 'https:'
	} catch {
		return false
	}
}

function firstForwardedValue(value: string | null): string | undefined {
	return value?.split(',')[0]?.trim() || undefined
}

function resolveVerificationOrigin(input: VerificationAuthorizeInput): { origin: string; rpId: string } {
	const headers = input.headers ?? input.request?.headers ?? new Headers()
	const fallbackUrl = input.url ?? input.request?.url
	if (!fallbackUrl) throw new Error('Verification request url is required.')
	const url = new URL(fallbackUrl)
	const forwardedProto = firstForwardedValue(headers.get('x-forwarded-proto'))
	const forwardedHost = firstForwardedValue(headers.get('x-forwarded-host'))
	const proto = forwardedProto ?? url.protocol.replace(/:$/, '')
	const host = forwardedHost ?? url.host
	const origin = `${proto}://${host}`
	const rpId = host.split(':')[0]!
	return { origin, rpId }
}

@RootService({ key: serviceName })
export class VerificationService {
	constructor(public ctx: PluxelContext) {}

	authorize(input: VerificationAuthorizeInput = {}): VerificationState {
		const config = this.readConfig()
		return this.readStatus(config, this.createAccess(input))
	}

	verifyPassword(input: VerificationPasswordVerifyInput): VerificationVerifyResult {
		const config = this.readConfig()
		if (config.method !== 'password') {
			return this.readStatus(config, this.createAccess(input))
		}

		const access = this.createAccess(input)
		const current = this.readStatus(config, access)
		if (current.allow) return current
		if (config.users.length === 0) return current

		const username = normalizeVerificationUsername(input.credentials.username)
		const user = findPasswordUser(config, username)
		const ok = !!user && verifyPasswordScrypt(input.credentials.password, user.passwordHash)
		if (!ok) {
			recordSecurityEvent(this.ctx, {
				area: 'verification',
				action: 'verify',
				status: 'failure',
				reason: current.reason ?? 'invalid_credentials',
				message: 'Host password verification failed.',
			})
			return current
		}
		return this.activateSession(username, input, access, 'Host password verification succeeded.')
	}

	verifyOtp(input: VerificationOtpVerifyInput): VerificationVerifyResult {
		const config = this.readConfig()
		if (config.method !== 'otp') {
			return this.readStatus(config, this.createAccess(input))
		}

		const access = this.createAccess(input)
		const current = this.readStatus(config, access)
		if (current.allow) return current
		if (config.users.length === 0) return current

		const username = normalizeVerificationUsername(input.credentials.username)
		const code = normalizeOtpCode(input.credentials.code)
		const user = findOtpUser(config, username)
		const ok = !!user && verifyTotpCode(user.otpSecret, code)
		if (!ok) {
			recordSecurityEvent(this.ctx, {
				area: 'verification',
				action: 'verify',
				status: 'failure',
				reason: current.reason ?? 'invalid_credentials',
				message: 'Host OTP verification failed.',
			})
			return current
		}
		return this.activateSession(username, input, access, 'Host OTP verification succeeded.')
	}

	async beginPasskeyRegistration(
		input: VerificationPasskeyRegistrationStartInput & VerificationAuthorizeInput,
	): Promise<VerificationPasskeyRegistrationOptions> {
		const config = this.readConfig()
		if (config.method !== 'passkey') throw new Error('Verification method must be passkey.')
		const username = normalizeVerificationUsername(input.username)
		if (!username) throw new Error('Username is required.')
		const relyingParty = resolveVerificationOrigin(input)
		const options = await buildPasskeyRegistrationOptions({
			rpId: relyingParty.rpId,
			rpName: OTP_ISSUER,
			username,
		})
		this.runtimeState().passkeyRegistration.set(username, {
			challenge: options.challenge,
			origin: relyingParty.origin,
			rpId: relyingParty.rpId,
		})
		return options
	}

	async finishPasskeyRegistration(
		input: VerificationPasskeyRegistrationFinishInput,
	): Promise<VerificationAdminState> {
		const config = this.readConfig()
		if (config.method !== 'passkey') throw new Error('Verification method must be passkey.')
		const username = normalizeVerificationUsername(input.username)
		const pending = this.runtimeState().passkeyRegistration.get(username)
		if (!pending) throw new Error('Passkey registration is not pending.')

		try {
			const user = await verifyPasskeyRegistration({
				expectedChallenge: pending.challenge,
				expectedOrigin: pending.origin,
				rpId: pending.rpId,
				input: {
					...input,
					username,
				},
			})

			await updateSecurityIdentity(this.ctx.root.fs, (current) => {
				const nextConfig = resolveVerificationConfig(current.verification)
				return {
					...current,
					verification: upsertPasskeyUser(nextConfig, user),
				}
			})
			return this.describe()
		} finally {
			this.clearPendingPasskey(username, 'registration')
		}
	}

	async beginPasskeyAuthentication(
		input: VerificationPasskeyAuthenticationStartInput & VerificationAuthorizeInput,
	): Promise<VerificationPasskeyAuthenticationOptions> {
		const config = this.readConfig()
		if (config.method !== 'passkey') throw new Error('Verification method must be passkey.')
		const username = normalizeVerificationUsername(input.username)
		if (!username) throw new Error('Username is required.')
		const user = findPasskeyUser(config, username)
		if (!user) throw new Error('Passkey user is not configured.')
		const relyingParty = resolveVerificationOrigin(input)
		const options = await buildPasskeyAuthenticationOptions({
			rpId: relyingParty.rpId,
			user,
		})
		this.runtimeState().passkeyAuthentication.set(username, {
			challenge: options.challenge,
			origin: relyingParty.origin,
			rpId: relyingParty.rpId,
		})
		return options
	}

	async finishPasskeyAuthentication(
		input: VerificationPasskeyAuthenticationFinishInput,
	): Promise<VerificationVerifyResult> {
		const username = normalizeVerificationUsername(input.username)
		const pending = this.runtimeState().passkeyAuthentication.get(username)
		if (!pending) throw new Error('Passkey authentication is not pending.')

		const currentConfig = this.readConfig()
		const currentUser = findPasskeyUser(currentConfig, username)
		if (!currentUser) throw new Error('Passkey user is not configured.')

		try {
			const nextUser = await verifyPasskeyAuthentication({
				expectedChallenge: pending.challenge,
				expectedOrigin: pending.origin,
				rpId: pending.rpId,
				user: currentUser,
				input: {
					...input,
					username,
				},
			})

			await updateSecurityIdentity(this.ctx.root.fs, (current) => {
				const config = resolveVerificationConfig(current.verification)
				return {
					...current,
					verification: upsertPasskeyUser(config, nextUser),
				}
			})

			const access = this.createAccess(input)
			return this.activateSession(username, input, access, 'Host passkey verification succeeded.')
		} finally {
			this.clearPendingPasskey(username, 'authentication')
		}
	}

	clear(): void {
		const state = this.runtimeState()
		state.revokedAfter = Date.now()
		recordSecurityEvent(this.ctx, {
			area: 'verification',
			action: 'clear',
			status: 'info',
			message: 'Cleared host verification state.',
		})
	}

	async setMode(mode: VerificationMode): Promise<VerificationAdminState> {
		await updateSecurityIdentity(this.ctx.root.fs, (current) => ({
			...current,
			verification: setVerificationConfigMode(resolveVerificationConfig(current.verification), mode),
		}))
		return this.describe()
	}

	async setMethod(method: VerificationMethod): Promise<VerificationAdminState> {
		await updateSecurityIdentity(this.ctx.root.fs, (current) => ({
			...current,
			verification: setVerificationConfigMethod(resolveVerificationConfig(current.verification), method),
		}))
		this.clearPendingPasskey()
		return this.describe()
	}

	async upsertPasswordUser(input: VerificationPasswordUserUpsertInput): Promise<VerificationAdminState> {
		const username = normalizeVerificationUsername(input.username)
		const password = requireVerificationPassword(input.password)
		if (!username) throw new Error('Username is required.')

		await updateSecurityIdentity(this.ctx.root.fs, (current) => {
			const config = resolveVerificationConfig(current.verification)
			return {
				...current,
				verification: upsertPasswordUser(config, {
					username,
					passwordHash: hashPasswordScrypt(password),
				}),
			}
		})
		return this.describe()
	}

	async provisionOtpUser(input: VerificationOtpUserProvisionInput): Promise<VerificationOtpProvisionResult> {
		const username = normalizeVerificationUsername(input.username)
		if (!username) throw new Error('Username is required.')

		const secret = generateOtpSecret()
		const otpauthUrl = buildOtpAuthUrl({
			issuer: OTP_ISSUER,
			username,
			secret,
		})

		await updateSecurityIdentity(this.ctx.root.fs, (current) => {
			const config = resolveVerificationConfig(current.verification)
			return {
				...current,
				verification: upsertOtpUser(config, {
					username,
					otpSecret: secret,
				}),
			}
		})

		return {
			verification: this.describe(),
			enrollment: {
				username,
				secret,
				otpauthUrl,
			},
		}
	}

	async deleteUser(input: VerificationUserDeleteInput): Promise<VerificationAdminState> {
		const username = normalizeVerificationUsername(input.username)
		if (!username) throw new Error('Username is required.')

		await updateSecurityIdentity(this.ctx.root.fs, (current) => ({
			...current,
			verification: deleteVerificationUser(resolveVerificationConfig(current.verification), username),
		}))
		this.clearPendingPasskey(username)
		return this.describe()
	}

	describe(input: VerificationAuthorizeInput = {}): VerificationAdminState {
		const config = this.readConfig()
		const state = this.readStatus(config, this.createAccess(input))
		return {
			mode: config.mode,
			method: config.method,
			users: listVerificationUsers(config),
			...state,
		}
	}

	private activateSession(
		username: string,
		input: VerificationAuthorizeInput,
		access: VerificationAccess,
		successMessage: string,
	): VerificationVerifyResult {
		const runtime = this.resolveRuntime()
		const next = this.createSessionPayload(runtime.version, access.now, username)
		access.cookieSession = next
		const state = this.readStatus(runtime.config, access)
		recordSecurityEvent(this.ctx, {
			area: 'verification',
			action: 'verify',
			status: state.allow ? 'success' : 'failure',
			reason: state.reason,
			message: successMessage,
		})
		return {
			...state,
			cookie: this.buildSessionCookie(runtime.version, next, input, access.now),
		}
	}

	private readStatus(config: VerificationConfig, access: VerificationAccess): VerificationState {
		if (config.mode === 'bypass') {
			return {
				allow: true,
				reason: 'bypass',
			}
		}
		if ((config.users ?? []).length === 0) {
			return {
				allow: false,
				reason: 'misconfigured',
			}
		}
		if (this.readActiveSession(config, access)) {
			return { allow: true }
		}
		return {
			allow: false,
			reason: 'verification_required',
		}
	}

	private readConfig() {
		const identity = readSecurityIdentitySync(this.ctx.root.fs)
		return resolveVerificationConfig(identity.verification)
	}

	private resolveRuntime(): VerificationRuntime {
		const config = this.readConfig()
		return this.resolveRuntimeForConfig(config)
	}

	private resolveRuntimeForConfig(config: VerificationConfig): VerificationRuntime {
		return {
			config,
			version: createHash('sha256').update(JSON.stringify(config)).digest('hex'),
			state: this.runtimeState(),
		}
	}

	private readActiveSession(
		config: VerificationConfig,
		access: VerificationAccess,
	): SessionPayload | undefined {
		const runtime = this.resolveRuntimeForConfig(config)
		const fromCookie = this.readCookieSession(runtime.version, access)
		if (
			fromCookie?.verified &&
			fromCookie.v === runtime.version &&
			config.users.some((user) => user.username === fromCookie.sub)
		) {
			return this.isRevoked(runtime.state, fromCookie.iat) ? undefined : fromCookie
		}
		return undefined
	}

	private createSessionPayload(version: string, now: number, sub: string): SessionPayload {
		return {
			verified: true,
			sub,
			iat: now,
			exp: now + VERIFICATION_SESSION_TTL_MS,
			v: version,
		}
	}

	private readCookieSession(version: string, access: VerificationAccess): SessionPayload | null {
		if (access.cookieSession !== undefined) return access.cookieSession
		if (!access.headers) {
			access.cookieSession = null
			return null
		}
		const cookie = parseCookie(access.headers.get('cookie'), VERIFICATION_COOKIE_NAME)
		if (!cookie) {
			access.cookieSession = null
			return null
		}

		const [payloadB64, sig] = cookie.split('.')
		if (!payloadB64 || !sig) {
			access.cookieSession = null
			return null
		}

		const expected = this.sign(payloadB64)
		try {
			const a = Buffer.from(expected)
			const b = Buffer.from(sig)
			if (a.length !== b.length || !timingSafeEqual(a, b)) {
				access.cookieSession = null
				return null
			}
		} catch {
			access.cookieSession = null
			return null
		}

		try {
			const decoded = JSON.parse(b64urlDecode(payloadB64).toString('utf8')) as SessionPayload
			if (
				!decoded ||
				typeof decoded !== 'object' ||
				decoded.verified !== true ||
				typeof decoded.sub !== 'string' ||
				!decoded.sub ||
				typeof decoded.iat !== 'number' ||
				typeof decoded.exp !== 'number' ||
				typeof decoded.v !== 'string' ||
				decoded.exp <= access.now ||
				decoded.v !== version
			) {
				access.cookieSession = null
				return null
			}
			access.cookieSession = decoded
			return access.cookieSession
		} catch {
			access.cookieSession = null
			return null
		}
	}

	private buildSessionCookie(
		version: string,
		payload: SessionPayload,
		input: VerificationAuthorizeInput,
		now: number,
	): string {
		const payloadB64 = b64url(JSON.stringify({ ...payload, v: version }))
		const sig = this.sign(payloadB64)
		const token = `${payloadB64}.${sig}`
		const headers = input.headers ?? input.request?.headers ?? new Headers()
		const secure = isSecureRequest(input.url ?? input.request?.url, headers)
		return `${VERIFICATION_COOKIE_NAME}=${token}; Path=/; Max-Age=${Math.floor(
			(payload.exp - now) / 1000,
		)}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`
	}

	private sign(payloadB64: string): string {
		return b64url(createHmac('sha256', this.runtimeState().secret).update(payloadB64).digest())
	}

	private isRevoked(state: VerificationRuntimeState, issuedAt: number): boolean {
		return typeof state.revokedAfter === 'number' && issuedAt <= state.revokedAfter
	}

	private runtimeState(): VerificationRuntimeState {
		const root = this.ctx.root as PluxelContext & { [STATE_SYMBOL]?: VerificationRuntimeState }
		root[STATE_SYMBOL] ??= {
			secret: b64url(randomBytes(32)),
			passkeyRegistration: new Map(),
			passkeyAuthentication: new Map(),
		}
		return root[STATE_SYMBOL]!
	}

	private clearPendingPasskey(
		username?: string,
		kind?: 'registration' | 'authentication',
	): void {
		const state = this.runtimeState()
		if (!username) {
			state.passkeyRegistration.clear()
			state.passkeyAuthentication.clear()
			return
		}
		if (!kind || kind === 'registration') state.passkeyRegistration.delete(username)
		if (!kind || kind === 'authentication') state.passkeyAuthentication.delete(username)
	}

	private createAccess(input: VerificationAuthorizeInput): VerificationAccess {
		return {
			now: Date.now(),
			headers: input.headers ?? input.request?.headers,
		}
	}
}
