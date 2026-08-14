export type WindowRatePolicy = {
	limit: number
	windowMs: number
}

export type RatePolicy =
	| (WindowRatePolicy & { algorithm: 'token-bucket'; burst?: number })
	| (WindowRatePolicy & { algorithm: 'fixed-window' })
	| (WindowRatePolicy & { algorithm: 'sliding-window-counter' })
	| (WindowRatePolicy & { algorithm: 'sliding-window-log' })

export type ResolvedRatePolicy =
	| (Readonly<WindowRatePolicy> & { readonly algorithm: 'token-bucket'; readonly burst: number })
	| (Readonly<WindowRatePolicy> & { readonly algorithm: 'fixed-window' })
	| (Readonly<WindowRatePolicy> & { readonly algorithm: 'sliding-window-counter' })
	| (Readonly<WindowRatePolicy> & { readonly algorithm: 'sliding-window-log' })

export type RateIdentityPart = string | number | bigint | boolean
export type RateIdentity =
	| RateIdentityPart
	| readonly RateIdentityPart[]
	| Readonly<Record<string, RateIdentityPart>>

export interface RateConsumeOptions {
	/** Units consumed by this operation. @default 1 */
	cost?: number
}

export type RateDecision =
	| {
			readonly denied: false
			readonly remaining: number
			readonly resetAt: number
	  }
	| {
			readonly denied: true
			readonly remaining: number
			readonly retryAfterMs: number
			readonly resetAt: number
	  }

export interface RateLimiter {
	consume(identity: RateIdentity, options?: RateConsumeOptions): Promise<RateDecision>
}

export interface RatesBinding {
	use(name: string, policy: RatePolicy): RateLimiter
}

export type RatesErrorCode =
	| 'RATES_STOPPED'
	| 'RATES_UNAVAILABLE'
	| 'RATES_POLICY_CONFLICT'
	| 'RATES_INVALID_ARGUMENT'

export type RatesArgument = 'name' | 'policy' | 'identity' | 'cost'
