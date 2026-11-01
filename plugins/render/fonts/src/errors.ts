export type FontsErrorCode =
	| 'NOT_RUNNING'
	| 'INVALID_INPUT'
	| 'INVALID_FONT'
	| 'FONT_TOO_LARGE'
	| 'FONT_LIMIT_EXCEEDED'
	| 'FONT_BUSY'
	| 'FONT_NOT_FOUND'
	| 'CORRUPT_FONT_STORAGE'

export class FontsError extends Error {
	override readonly name = 'FontsError'

	constructor(
		readonly code: FontsErrorCode,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options)
	}
}
