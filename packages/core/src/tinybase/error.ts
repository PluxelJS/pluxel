import type { TinyBaseIdentity } from './types'

export class TinyBaseError extends Error {
	constructor(
		readonly code:
			| 'INVALID_STORE'
			| 'STORE_IN_USE'
			| 'OPEN_CONFLICT'
			| 'NOT_OPEN'
			| 'TRANSACTION_ACTIVE'
			| 'SNAPSHOT_INVALID'
			| 'BUDGET_EXCEEDED'
			| 'RESTORE_FAILED'
			| 'SAVE_FAILED'
			| 'WRITER_BLOCKED'
			| 'CLOSED',
		message: string,
		readonly identity: TinyBaseIdentity,
		options?: ErrorOptions,
	) {
		super(`[core.tinybase] ${message}`, options)
		this.name = 'TinyBaseError'
	}
}
