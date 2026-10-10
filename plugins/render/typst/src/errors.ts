export type TypstErrorCode =
	| 'INVALID_INPUT'
	| 'LIMIT_EXCEEDED'
	| 'COMPILE_FAILED'
	| 'CLOSED'
	| 'BUSY'
	| 'STALE_REVISION'

export interface TypstDiagnostic {
	readonly severity: 'error' | 'warning' | 'info'
	readonly message: string
	readonly path?: string
	readonly range?: {
		readonly start: { readonly line: number; readonly character: number }
		readonly end: { readonly line: number; readonly character: number }
	}
}

/** Contract and compilation failures. Native/IO/Worker errors retain their own contracts. */
export class TypstError extends Error {
	readonly code: TypstErrorCode
	readonly path?: string
	readonly diagnostics: readonly TypstDiagnostic[]
	constructor(
		code: TypstErrorCode,
		message: string,
		options: ErrorOptions & { path?: string; diagnostics?: readonly TypstDiagnostic[] } = {},
	) {
		super(message, options)
		this.name = 'TypstError'
		this.code = code
		this.path = options.path
		this.diagnostics = options.diagnostics ?? []
	}
}
