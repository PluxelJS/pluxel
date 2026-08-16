import { BasePlugin, type PluginNodeAddressSnapshot } from '@pluxel/runtime'
import type { RateDecision, ResolvedRatePolicy } from './types.ts'

export interface RatesBackendConsumeRequest {
	/** Opaque, versioned caller/limiter/identity encoding. */
	readonly key: string
	/** Full structured owner snapshot. `null` identifies an explicit global limiter. */
	readonly owner: PluginNodeAddressSnapshot | null
	readonly policy: Readonly<ResolvedRatePolicy>
	readonly cost: number
}

/** Atomic backend contract for memory, Redis, or another admission store. */
export abstract class RatesBackend extends BasePlugin {
	abstract consume(request: RatesBackendConsumeRequest): Promise<RateDecision>
}

export type { RateDecision, ResolvedRatePolicy } from './types.ts'
