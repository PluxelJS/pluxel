export type EChartsErrorCode =
	| 'NOT_RUNNING'
	| 'INVALID_INPUT'
	| 'INVALID_THEME'
	| 'THEME_TOO_LARGE'
	| 'THEME_LIMIT_EXCEEDED'
	| 'THEME_CONFLICT'
	| 'THEME_NOT_FOUND'
	| 'INVALID_IMAGE_SOURCE'
	| 'IMAGE_SOURCE_TOO_LARGE'
	| 'UNSUPPORTED_IMAGE_SOURCE'
	| 'IMAGE_LOAD_FAILED'
	| 'WORKER_INPUT_UNSUPPORTED'
	| 'RENDER_BUSY'
	| 'RENDER_FAILED'

export class EChartsError extends Error {
	override readonly name = 'EChartsError'

	constructor(
		readonly code: EChartsErrorCode,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options)
	}
}
