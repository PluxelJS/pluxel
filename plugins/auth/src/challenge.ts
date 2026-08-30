import type {
	ManagementAccessPrincipal,
	ManagementAuthenticationCookieCommit,
	ManagementAuthenticationProviderSession,
	ManagementAuthenticationProviderStep,
} from '@pluxel/runtime'

const AUTHENTICATION_TTL_MS = 2 * 60_000

type PasswordResult = 'accepted' | 'rejected' | 'limited' | 'unavailable'

export type PasswordAuthenticationActions = Readonly<{
	label?: string
	requireTotp: boolean
	verifyPassword(password: string): Promise<PasswordResult>
	verifyTotp(code: string): Promise<PasswordResult>
	authenticated(): ManagementAuthenticationProviderStep
	logout?(): ManagementAuthenticationCookieCommit | undefined
}>

function exactRecord(value: unknown, key: string): Record<string, unknown> | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
	const record = value as Record<string, unknown>
	const keys = Object.keys(record)
	return keys.length === 1 && keys[0] === key ? record : undefined
}

function failure(
	result: Exclude<PasswordResult, 'accepted'>,
): ManagementAuthenticationProviderStep {
	return Object.freeze({
		kind: 'failed',
		code:
			result === 'limited'
				? 'attempt_limited'
				: result === 'unavailable'
					? 'access_unavailable'
					: 'authentication_failed',
	})
}

export class FixedAuthenticationSession implements ManagementAuthenticationProviderSession {
	private disposed = false

	constructor(
		private readonly step: ManagementAuthenticationProviderStep,
		private logoutAction?: () => ManagementAuthenticationCookieCommit | undefined,
	) {}

	state(): ManagementAuthenticationProviderStep {
		return this.disposed
			? Object.freeze({ kind: 'failed', code: 'authentication_expired' })
			: this.step
	}

	submit(_input: unknown): ManagementAuthenticationProviderStep {
		return this.disposed
			? Object.freeze({ kind: 'failed', code: 'authentication_expired' })
			: Object.freeze({ kind: 'failed', code: 'authentication_failed' })
	}

	logout(): ManagementAuthenticationCookieCommit | undefined {
		return this.disposed ? undefined : this.logoutAction?.()
	}

	[Symbol.dispose](): void {
		this.disposed = true
		this.logoutAction = undefined
	}
}

export class PasswordAuthenticationSession implements ManagementAuthenticationProviderSession {
	private phase: 'password' | 'totp' | 'terminal' = 'password'
	private terminal?: ManagementAuthenticationProviderStep
	private disposed = false
	private submitting = false
	private readonly expiresAt = Date.now() + AUTHENTICATION_TTL_MS
	private actions: PasswordAuthenticationActions | undefined
	private logoutAction?: () => ManagementAuthenticationCookieCommit | undefined

	constructor(actions: PasswordAuthenticationActions | undefined) {
		this.actions = actions
		this.logoutAction = actions?.logout
	}

	logout(): ManagementAuthenticationCookieCommit | undefined {
		return this.disposed ? undefined : this.logoutAction?.()
	}

	state(): ManagementAuthenticationProviderStep {
		const expired = this.expired()
		if (expired) return expired
		if (this.terminal) return this.terminal
		const actions = this.actions
		if (!actions) return Object.freeze({ kind: 'failed', code: 'authentication_expired' })
		return this.phase === 'password'
			? Object.freeze({
					kind: 'challenge',
					challenge: Object.freeze({
						kind: 'password',
						...(actions.label ? { label: actions.label } : {}),
					}),
				})
			: Object.freeze({
					kind: 'challenge',
					challenge: Object.freeze({ kind: 'totp', digits: 6 }),
				})
	}

	async submit(input: unknown): Promise<ManagementAuthenticationProviderStep> {
		const expired = this.expired()
		if (expired) return expired
		if (this.terminal || this.phase === 'terminal') {
			return Object.freeze({ kind: 'failed', code: 'authentication_expired' })
		}
		const actions = this.actions
		if (!actions) return Object.freeze({ kind: 'failed', code: 'authentication_expired' })
		if (this.submitting) {
			return this.finish(Object.freeze({ kind: 'failed', code: 'attempt_limited' }))
		}

		if (this.phase === 'password') {
			const record = exactRecord(input, 'password')
			const password = record?.password
			if (typeof password !== 'string' || password.length === 0 || password.length > 1_024) {
				return this.finish(Object.freeze({ kind: 'failed', code: 'authentication_failed' }))
			}
			this.submitting = true
			try {
				const result = await actions.verifyPassword(password)
				if (!this.stillActive('password', actions)) return this.expiredStep()
				if (result !== 'accepted') return this.finish(failure(result))
				if (actions.requireTotp) {
					this.phase = 'totp'
					return this.state()
				}
				return this.finish(actions.authenticated())
			} finally {
				this.submitting = false
			}
		}

		const record = exactRecord(input, 'code')
		const code = record?.code
		if (typeof code !== 'string' || !/^\d{6}$/.test(code)) {
			return this.finish(Object.freeze({ kind: 'failed', code: 'authentication_failed' }))
		}
		this.submitting = true
		try {
			const result = await actions.verifyTotp(code)
			if (!this.stillActive('totp', actions)) return this.expiredStep()
			return this.finish(result === 'accepted' ? actions.authenticated() : failure(result))
		} finally {
			this.submitting = false
		}
	}

	[Symbol.dispose](): void {
		if (this.disposed) return
		this.disposed = true
		this.phase = 'terminal'
		this.terminal = undefined
		this.actions = undefined
		this.logoutAction = undefined
	}

	private expired(): ManagementAuthenticationProviderStep | undefined {
		if (!this.disposed && Date.now() < this.expiresAt) return undefined
		this[Symbol.dispose]()
		return this.expiredStep()
	}

	private expiredStep(): ManagementAuthenticationProviderStep {
		return Object.freeze({ kind: 'failed', code: 'authentication_expired' })
	}

	private stillActive(phase: 'password' | 'totp', actions: PasswordAuthenticationActions): boolean {
		return (
			!this.disposed &&
			this.phase === phase &&
			this.actions === actions &&
			Date.now() < this.expiresAt
		)
	}

	private finish(step: ManagementAuthenticationProviderStep): ManagementAuthenticationProviderStep {
		this.phase = 'terminal'
		this.terminal = step
		this.actions = undefined
		return step
	}
}

export function authenticatedSession(
	principal: ManagementAccessPrincipal,
	logout?: () => ManagementAuthenticationCookieCommit | undefined,
): FixedAuthenticationSession {
	return new FixedAuthenticationSession(Object.freeze({ kind: 'authenticated', principal }), logout)
}
