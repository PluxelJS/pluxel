import type { SourcePosition, TypstDiagnostic } from '@pluxel/plugin-typst/browser'
import type { TypstGeneratedMapping } from '@pluxel/plugin-typst/tiptap'

/** Local HTTP boundary: project errors explicitly, never serialize an Error object. */
export interface ConsumerFailure {
	kind: 'typst' | 'worker' | 'io' | 'cancelled' | 'unexpected'
	name: string
	code: string
	message: string
	path?: string
	diagnostics: readonly TypstDiagnostic[]
	clientRevision?: number
	/** May be absent when failure occurs before region generation. */
	mapping?: TypstGeneratedMapping[]
}

/** Diagnostics are zero-based UTF-16; native mapping/navigation is one-based UTF-16. */
export function diagnosticPosition(diagnostic: TypstDiagnostic): SourcePosition | undefined {
	return diagnostic.path && diagnostic.range
		? {
				path: diagnostic.path.replace(/^\//, ''),
				line: diagnostic.range.start.line + 1,
				column: diagnostic.range.start.character + 1,
			}
		: undefined
}

export function sourceOffset(source: string, position: SourcePosition): number | undefined {
	if (
		!Number.isSafeInteger(position.line) ||
		position.line < 1 ||
		!Number.isSafeInteger(position.column)
	)
		return undefined
	const lines = source.split('\n')
	const line = lines[position.line - 1]
	if (line === undefined || position.column < 1 || position.column > line.length + 1)
		return undefined
	return (
		lines.slice(0, position.line - 1).reduce((sum, text) => sum + text.length + 1, 0) +
		position.column -
		1
	)
}
