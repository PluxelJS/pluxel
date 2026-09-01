export type PiAgentErrorCode =
	| 'NOT_RUNNING'
	| 'INVALID_INPUT'
	| 'SESSION_LIMIT'
	| 'SESSION_NOT_FOUND'
	| 'TOOL_SETUP_NOT_FOUND'
	| 'MODEL_NOT_FOUND'
	| 'SESSION_BUSY'
	| 'SUBAGENT_LIMIT'
	| 'SUBAGENT_DEPTH'
	| 'ABORTED'

export class PiAgentError extends Error {
	readonly code: PiAgentErrorCode
	readonly publicMessage: string
	readonly details?: Readonly<Record<string, unknown>>

	constructor(
		code: PiAgentErrorCode,
		publicMessage: string,
		options?: { message?: string; details?: Readonly<Record<string, unknown>>; cause?: unknown },
	) {
		super(
			options?.message ?? publicMessage,
			options?.cause !== undefined ? { cause: options.cause } : undefined,
		)
		this.name = 'PiAgentError'
		this.code = code
		this.publicMessage = publicMessage
		this.details = options?.details
	}
}
