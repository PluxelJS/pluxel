export type MarkdownErrorCode =
	| 'NOT_RUNNING'
	| 'INVALID_INPUT'
	| 'MARKDOWN_TOO_LARGE'
	| 'AST_LIMIT_EXCEEDED'
	| 'HTML_TOO_LARGE'
	| 'ASSET_COUNT_EXCEEDED'
	| 'ASSET_TOO_LARGE'
	| 'ASSET_BYTES_EXCEEDED'
	| 'CODE_LIMIT_EXCEEDED'
	| 'EXTENSION_FAILED'
	| 'INTERNAL_ASSET_COLLISION'

export class MarkdownError extends Error {
	override readonly name = 'MarkdownError'

	constructor(
		readonly code: MarkdownErrorCode,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options)
	}
}
