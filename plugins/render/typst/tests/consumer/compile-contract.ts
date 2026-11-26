import type { SourcePosition, TypstDiagnostic } from '@pluxel/plugin-typst/browser'

/** Local HTTP boundary: project errors explicitly, never serialize an Error object. */
export interface ConsumerFailure {
	kind: 'typst' | 'worker' | 'io' | 'cancelled' | 'unexpected'
	name: string
	code: string
	message: string
	path?: string
	diagnostics: readonly TypstDiagnostic[]
	clientRevision?: number
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
