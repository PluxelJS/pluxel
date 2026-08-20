export type ScaffoldErrorCode =
	| 'TEMPLATE_NOT_FOUND'
	| 'TEMPLATE_CONTRACT_INVALID'
	| 'TEMPLATE_SCHEMA_UNSUPPORTED'
	| 'TEMPLATE_RENDER_INVALID'
	| 'TEMPLATE_OUTPUT_CONFLICT'
	| 'TARGET_CONFLICT'
	| 'INSTALL_FAILED'

export class ScaffoldError extends Error {
	readonly code: ScaffoldErrorCode

	constructor(code: ScaffoldErrorCode, message: string, options?: ErrorOptions) {
		super(`[${code}] ${message}`, options)
		this.name = 'ScaffoldError'
		this.code = code
	}
}

export function scaffoldError(
	code: ScaffoldErrorCode,
	message: string,
	cause?: unknown,
): ScaffoldError {
	return new ScaffoldError(code, message, cause === undefined ? undefined : { cause })
}
