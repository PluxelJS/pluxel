import type { TypstSourceMapping } from './types.js'

interface LocatedSource {
	readonly path: string
	readonly source: string
	readonly mapping: readonly TypstSourceMapping[]
}

/** Native Typst source navigation uses one-based lines and UTF-16 columns. */
export interface TypstSourcePosition {
	path: string
	line: number
	column: number
}

/** Convert one-based UTF-16 source coordinates to a UTF-16 offset for a source editor. */
export function findTypstSourceOffset({
	source,
	position,
}: {
	source: string
	position: Pick<TypstSourcePosition, 'line' | 'column'>
}): number | undefined {
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
	const lineEnd = end < 0 ? source.length : end > start && source[end - 1] === '\r' ? end - 1 : end
	const at = start + position.column - 1
	if (at > lineEnd) return
	if (at > 0 && /[\uD800-\uDBFF]/.test(source[at - 1]!) && /[\uDC00-\uDFFF]/.test(source[at] ?? ''))
		return
	return at
}

/** Maps into an exact text span when possible; opaque syntax selects its containing source node. */
export function findTypstEditorPosition({
	projection,
	sourcePosition,
}: {
	projection: LocatedSource
	sourcePosition: TypstSourcePosition
}): number | undefined {
	if (sourcePosition.path.replace(/^\//, '') !== projection.path) return
	const at = findTypstSourceOffset({ source: projection.source, position: sourcePosition })
	if (at === undefined) return
	const byte = new TextEncoder().encode(projection.source.slice(0, at)).length
	let found: TypstSourceMapping | undefined
	for (const entry of projection.mapping) {
		if (byte < entry.from || byte > entry.to) continue
		if (
			!found ||
			(Number(found.kind === 'text') - Number(entry.kind === 'text') ||
				entry.to - entry.from - (found.to - found.from)) < 0
		)
			found = entry
	}
	if (!found) return
	return found.kind === 'text' && byte === found.to ? found.endPosition : found.position
}

/** Resolves a native editor position against the same immutable source revision as its projection. */
export function findTypstSourcePosition({
	projection,
	position,
}: {
	projection: LocatedSource
	position: number
}): TypstSourcePosition | undefined {
	if (!Number.isSafeInteger(position) || position < 0) return
	let found: TypstSourceMapping | undefined
	let rank = Infinity
	for (const entry of projection.mapping) {
		if (position < entry.position || position > entry.endPosition) continue
		const nextRank =
			entry.kind === 'text'
				? position === entry.endPosition
					? 2
					: 0
				: position === entry.position
					? 1
					: 3
		if (
			nextRank < rank ||
			(nextRank === rank &&
				entry.endPosition - entry.position < found!.endPosition - found!.position)
		) {
			found = entry
			rank = nextRank
		}
	}
	if (!found) return
	let byte = found.from
	const bytes = new TextEncoder().encode(projection.source)
	// Typst attributes a markup call to its expression, excluding the leading # token.
	if (bytes[byte] === 35 && found.kind !== 'text') byte += 1
	const prefix = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, byte))
	const lines = prefix.split('\n')
	return { path: projection.path, line: lines.length, column: lines.at(-1)!.length + 1 }
}
