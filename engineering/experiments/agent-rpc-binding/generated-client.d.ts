// Generated from real @pluxel/commands definitions.
export type RpcFailure = {
	readonly message: string
	readonly callId: string
	readonly outcome: 'not_started' | 'unknown'
} & (
	| {
			readonly code: 'INPUT_VALIDATION'
			readonly issues: readonly {
				readonly path?: readonly (string | number)[]
				readonly code?: string
				readonly message: string
			}[]
	  }
	| { readonly code: 'REJECTED'; readonly reason: string }
	| {
			readonly code:
				| 'FORBIDDEN'
				| 'COMMAND_NOT_FOUND'
				| 'PUBLICATION_GONE'
				| 'ABORTED'
				| 'TIMEOUT'
				| 'DEPENDENCY'
				| 'INTERNAL'
				| 'OUTPUT_ENCODING'
				| 'OUTPUT_LIMIT'
	  }
)
export type RpcResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly error: RpcFailure }
export interface RecordsApi {
	write(input: { description?: string; id: string; offset: string }): Promise<
		RpcResult<{
			operationId: string
			committed: boolean
			counts: { accepted: number; rejected: number }
		}>
	>
	read(input: { id: string }): Promise<RpcResult<{ id: string; text: null | string }>>
}
