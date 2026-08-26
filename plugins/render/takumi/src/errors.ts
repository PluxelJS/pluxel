export type TakumiErrorCode =
	| 'NOT_RUNNING'
	| 'INVALID_INPUT'
	| 'DIMENSIONS_EXCEEDED'
	| 'PIXELS_EXCEEDED'
	| 'CONTENT_TOO_LARGE'
	| 'STYLESHEET_TOO_LARGE'
	| 'IMAGE_BYTES_EXCEEDED'
	| 'INVALID_IMAGE'
	| 'FONT_COUNT_EXCEEDED'
	| 'FONT_BYTES_EXCEEDED'
	| 'FONT_LOAD_FAILED'
	| 'OUTPUT_TOO_LARGE'
	| 'RENDER_TIMEOUT'
	| 'RENDER_BUSY'
	| 'RENDER_FAILED'

export class TakumiError extends Error {
	override readonly name = 'TakumiError'

	constructor(
		readonly code: TakumiErrorCode,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options)
	}
}
