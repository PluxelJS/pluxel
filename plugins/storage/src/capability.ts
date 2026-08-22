import { BasePlugin } from '@pluxel/runtime'
import type { S3mini } from 's3mini'

/**
 * The author-facing s3mini surface exposed by every S3 provider.
 *
 * Keeping the method signatures anchored to s3mini means a real `S3mini` instance is a client
 * without an adapter, while local and platform providers can implement the same protocol. Its
 * underscored transport fields are implementation details rather than consumer operations.
 */
export type S3Client = Omit<S3mini, `_${string}`>

export class S3NotRunningError extends Error {
	override name = 'S3NotRunningError'
	readonly code = 'S3_NOT_RUNNING'

	constructor() {
		super('S3 capability belongs to a stopped or replaced provider.')
	}
}

/** Stable failure for S3 operations that a provider cannot implement without changing semantics. */
export class S3UnsupportedOperationError extends Error {
	override name = 'S3UnsupportedOperationError'
	readonly code = 'S3_UNSUPPORTED_OPERATION'

	constructor(readonly operation: string) {
		super(`The active S3 provider does not support ${operation}.`)
	}
}

/** Raw S3 capability. Consumers use s3mini's API; the host selects its implementation. */
export abstract class S3 extends BasePlugin {
	abstract get client(): S3Client
}
