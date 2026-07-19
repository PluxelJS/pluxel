import type { RatesArgument, RatesErrorCode, ResolvedRatePolicy } from './types.ts'

export abstract class RatesError extends Error {
	abstract readonly code: RatesErrorCode
}

export class RatesStoppedError extends RatesError {
	override name = 'RatesStoppedError'
	readonly code = 'RATES_STOPPED' as const

	constructor() {
		super('The rate limiter belongs to a stopped or replaced plugin generation.')
	}
}

export class RatesUnavailableError extends RatesError {
	override name = 'RatesUnavailableError'
	readonly code = 'RATES_UNAVAILABLE' as const
	readonly retryAfterMs?: number

	constructor(options: { cause?: unknown; retryAfterMs?: number } = {}) {
		super('The rates backend could not make an admission decision.', { cause: options.cause })
		this.retryAfterMs = options.retryAfterMs
	}
}

export class RatesPolicyConflictError extends RatesError {
	override name = 'RatesPolicyConflictError'
	readonly code = 'RATES_POLICY_CONFLICT' as const

	constructor(
		readonly active: Readonly<ResolvedRatePolicy>,
		readonly requested: Readonly<ResolvedRatePolicy>,
	) {
		super('An active rate limiter or identity uses a different resolved policy.')
	}
}

export class RatesInvalidArgumentError extends RatesError {
	override name = 'RatesInvalidArgumentError'
	readonly code = 'RATES_INVALID_ARGUMENT' as const

	constructor(
		readonly argument: RatesArgument,
		reason: string,
	) {
		super(`Invalid rate ${argument}: ${reason}`)
	}
}
