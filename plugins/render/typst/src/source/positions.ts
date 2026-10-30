import type { TypstSourceProjection } from './types.js'

/** Native Typst source navigation uses one-based lines and UTF-16 columns. */
export interface TypstSourcePosition {
	path: string
	line: number
	column: number
}

function offset(source: string, position: TypstSourcePosition): number | undefined {
	if (
		!Number.isSafeInteger(position.line) ||
		!Number.isSafeInteger(position.column) ||
		position.line < 1 ||
		position.column < 1
	)
		return
	let start = 0
	for (let line = 1; line < position.line; line++) {
		const next = source.indexOf('\n', start)
		if (next < 0) return
		start = next + 1
	}
	const end = source.indexOf('\n', start)
	const at = start + position.column - 1
	if (at > (end < 0 ? source.length : end)) return
	if (at > 0 && /[\uD800-\uDBFF]/.test(source[at - 1]!) && /[\uDC00-\uDFFF]/.test(source[at] ?? ''))
		return
	return at
}

/** Maps into an exact text span when possible; opaque syntax selects its containing source node. */
export function findTypstEditorPosition({
	projection,
	sourcePosition,
}: {
	projection: TypstSourceProjection
	sourcePosition: TypstSourcePosition
}): number | undefined {
	if (sourcePosition.path.replace(/^\//, '') !== projection.path) return
	const at = offset(projection.source, sourcePosition)
	if (at === undefined) return
	const byte = new TextEncoder().encode(projection.source.slice(0, at)).length
	const entries = projection.mapping
		.filter((entry) => byte >= entry.from && byte <= entry.to)
		.sort(
			(a, b) =>
				(a.kind === 'text' ? 0 : 1) - (b.kind === 'text' ? 0 : 1) ||
				a.to - a.from - (b.to - b.from),
		)
	const found = entries[0]
	if (!found) return
	return found.kind === 'text' && byte === found.to ? found.endPosition : found.position
}

/** Resolves a native editor position against the same immutable source revision as its projection. */
export function findTypstSourcePosition({
	projection,
	position,
}: {
	projection: TypstSourceProjection
	position: number
}): TypstSourcePosition | undefined {
	if (!Number.isSafeInteger(position) || position < 0) return
	const entries = projection.mapping
		.filter((entry) => position >= entry.position && position <= entry.endPosition)
		.sort(
			(a, b) =>
				(a.kind === 'text' ? 0 : 1) - (b.kind === 'text' ? 0 : 1) ||
				a.endPosition - a.position - (b.endPosition - b.position),
		)
	const found = entries[0]
	if (!found) return
	const byte = found.kind === 'text' && position === found.endPosition ? found.to : found.from
	const prefix = new TextDecoder('utf-8', { fatal: true }).decode(
		new TextEncoder().encode(projection.source).subarray(0, byte),
	)
	const lines = prefix.split('\n')
	return { path: projection.path, line: lines.length, column: lines.at(-1)!.length + 1 }
}
