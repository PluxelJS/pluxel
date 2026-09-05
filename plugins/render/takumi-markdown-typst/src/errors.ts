export type TypstMathErrorCode =
	| 'NOT_RUNNING'
	| 'FORMULA_INVALID'
	| 'FORMULA_TOO_LARGE'
	| 'FORMULA_COMPILE_FAILED'
	| 'SVG_TOO_LARGE'

export class TypstMathError extends Error {
	override readonly name = 'TypstMathError'

	constructor(
		readonly code: TypstMathErrorCode,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options)
	}
}
