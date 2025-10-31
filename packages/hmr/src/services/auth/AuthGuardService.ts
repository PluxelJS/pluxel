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
}

@Injectable({ key: serviceName })
export class AuthGuardService {
	private readonly guards = new Map<string, AuthGuardRegistration>()

	constructor(private readonly ctx: Context) {
		this.ctx.honoService.activateAuthGuard()
	}

	registerGuard(reg: AuthGuardRegistration): () => void {
		if (!reg.pluginName) {
			throw new Error('[AuthGuardService] pluginName is required when registering a guard.')
		}
		this.guards.set(reg.pluginName, reg)
		return () => {
			const current = this.guards.get(reg.pluginName)
			if (current === reg) {
				this.guards.delete(reg.pluginName)
			}
		}
	}

	unregisterGuard(pluginName: string): void {
		this.guards.delete(pluginName)
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
