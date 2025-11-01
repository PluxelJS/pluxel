import { Injectable, type Context } from '@pluxel/core'

const serviceName = 'authGuard' as const

declare module '@pluxel/core' {
	interface Context {
		[serviceName]: AuthGuardService
	}
}

export type AuthGuardDecision =
	| boolean
	| {
			allow: boolean
			reason?: string
			redirectPath?: string
	  }

export interface AuthGuardContext {
	path: string
	method: string
	headers: Headers
	request?: Request
	url?: URL
	context?: Readonly<Record<string, unknown>>
}

export interface AuthGuardRegistration {
	pluginName: string
	verificationPath?: string
	check: (ctx: AuthGuardContext) => Promise<AuthGuardDecision> | AuthGuardDecision
}

export type AuthGuardResult =
	| { allow: true }
	| {
			allow: false
			pluginName: string
			reason?: string
			redirectPath?: string
	  }

export type AuthGuardCheckInput = {
	path: string
	method?: string
	headers?: Headers | Record<string, string | readonly string[]>
	request?: Request
	url?: URL
	context?: Readonly<Record<string, unknown>>
}

@Injectable({ key: serviceName })
export class AuthGuardService {
	private readonly guards = new Map<string, AuthGuardRegistration>()
	private readonly logger: NonNullable<Context['logger']>

	constructor(private readonly ctx: Context) {
		this.logger = ctx.logger!
		this.ctx.honoService.activateAuthGuard()
	}

	registerGuard(reg: AuthGuardRegistration): () => void {
		if (!reg.pluginName) {
			throw new Error('[AuthGuardService] pluginName is required when registering a guard.')
		}
		const replacing = this.guards.has(reg.pluginName)
		this.guards.set(reg.pluginName, reg)

		if (replacing) {
			this.logger.warn('[AuthGuard] Replaced existing guard registration', {
				pluginName: reg.pluginName,
			})
		} else {
			this.logger.info('[AuthGuard] Guard registered', { pluginName: reg.pluginName })
		}

		return () => {
			const current = this.guards.get(reg.pluginName)
			if (current === reg) {
				this.guards.delete(reg.pluginName)
				this.logger.info('[AuthGuard] Guard unregistered', { pluginName: reg.pluginName })
			}
		}
	}

	unregisterGuard(pluginName: string): void {
		if (this.guards.delete(pluginName)) {
			this.logger.info('[AuthGuard] Guard unregistered', { pluginName })
		}
	}

	async check(input: AuthGuardCheckInput): Promise<AuthGuardResult> {
		if (this.guards.size === 0) return { allow: true }

		const method = input.method?.toUpperCase() ?? (input.request?.method ?? 'GET')
		const headers =
			input.headers instanceof Headers
				? input.headers
				: new Headers(input.headers ?? (input.request ? input.request.headers : undefined))
		const url = input.url ?? (input.request ? new URL(input.request.url) : undefined)

		const ctx: AuthGuardContext = {
			path: input.path,
			method,
			headers,
			request: input.request,
			url,
			context: input.context,
		}

		for (const [pluginName, registration] of this.guards) {
			const decision = await registration.check(ctx)
			const result = this.normalizeDecision(pluginName, registration.verificationPath, decision)
			if (!result.allow) return result
		}

		return { allow: true }
	}

	getRegisteredPlugins(): readonly string[] {
		return Array.from(this.guards.keys())
	}

	hasGuards(): boolean {
		return this.guards.size > 0
	}

	private normalizeDecision(
		pluginName: string,
		fallbackRedirect: string | undefined,
		decision: AuthGuardDecision,
	): AuthGuardResult {
		if (decision === true) return { allow: true }
		if (decision === false) {
			return {
				allow: false,
				pluginName,
				redirectPath: fallbackRedirect,
			}
		}
		if (decision == null) return { allow: true }

		const allow =
			typeof (decision as any).allow === 'boolean' ? (decision as { allow: boolean }).allow : Boolean(decision)

		if (allow) return { allow: true }

		const redirect =
			(decision as { redirectPath?: string }).redirectPath !== undefined
				? (decision as { redirectPath?: string }).redirectPath
				: fallbackRedirect

		return {
			allow: false,
			pluginName,
			reason: (decision as { reason?: string }).reason,
			redirectPath: redirect,
		}
	}
}
