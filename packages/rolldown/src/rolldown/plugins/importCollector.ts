import type { Program } from 'oxc-parser'

export type CollectedImportKind = 'static' | 'dynamic'

export interface CollectedImportSpecifier {
	specifier: string
	kind: CollectedImportKind
	start?: number
	end?: number
}

type NodeLike = {
	type?: unknown
	start?: unknown
	end?: unknown
	[key: string]: unknown
}

const SKIP_KEYS = new Set([
	'type',
	'start',
	'end',
	'loc',
	'range',
	'comments',
	'leadingComments',
	'trailingComments',
	'innerComments',
])

export function collectImportSpecifiers(ast: Program): CollectedImportSpecifier[] {
	const out: CollectedImportSpecifier[] = []

	for (const statement of ast.body ?? []) {
		if (!statement || typeof statement !== 'object') continue
		const node = statement as NodeLike
		if (
			node.type === 'ImportDeclaration' ||
			node.type === 'ExportNamedDeclaration' ||
			node.type === 'ExportAllDeclaration'
		) {
			const specifier = readLiteralString((node as { source?: unknown }).source)
			if (specifier) out.push(withRange({ specifier, kind: 'static' }, node.source))
		}
	}

	visitNode(ast as unknown as NodeLike, (node) => {
		if (node.type === 'ImportExpression') {
			const specifier = readImportSource((node as { source?: unknown }).source)
			if (specifier) out.push(withRange({ specifier, kind: 'dynamic' }, node.source))
			return
		}

		// Older ESTree-compatible parsers may represent `import("x")` as a CallExpression.
		if (node.type === 'CallExpression' && isImportCallee((node as { callee?: unknown }).callee)) {
			const first = (node as { arguments?: unknown }).arguments
			const source = Array.isArray(first) ? first[0] : undefined
			const specifier = readImportSource(source)
			if (specifier) out.push(withRange({ specifier, kind: 'dynamic' }, source))
		}
	})

	return out
}

function readImportSource(node: unknown): string | null {
	const literal = readLiteralString(node)
	if (literal) return literal

	if (!node || typeof node !== 'object') return null
	const value = node as NodeLike
	if (value.type !== 'TemplateLiteral') return null

	const expressions = (value as { expressions?: unknown }).expressions
	if (Array.isArray(expressions) && expressions.length > 0) return null

	const quasis = (value as { quasis?: unknown }).quasis
	if (!Array.isArray(quasis) || quasis.length !== 1) return null
	const quasi = quasis[0]
	if (!quasi || typeof quasi !== 'object') return null
	const cooked = ((quasi as { value?: unknown }).value as { cooked?: unknown } | undefined)?.cooked
	const raw = ((quasi as { value?: unknown }).value as { raw?: unknown } | undefined)?.raw
	return typeof cooked === 'string' ? cooked : typeof raw === 'string' ? raw : null
}

function readLiteralString(node: unknown): string | null {
	if (!node || typeof node !== 'object') return null
	const value = node as { type?: unknown; value?: unknown }
	return value.type === 'Literal' && typeof value.value === 'string' ? value.value : null
}

function isImportCallee(node: unknown): boolean {
	if (!node || typeof node !== 'object') return false
	return (node as { type?: unknown }).type === 'Import'
}

function withRange<T extends CollectedImportSpecifier>(item: T, node: unknown): T {
	if (!node || typeof node !== 'object') return item
	const range = node as { start?: unknown; end?: unknown }
	if (typeof range.start === 'number') item.start = range.start
	if (typeof range.end === 'number') item.end = range.end
	return item
}

function visitNode(node: unknown, visit: (node: NodeLike) => void): void {
	if (!node || typeof node !== 'object') return
	if (Array.isArray(node)) {
		for (const item of node) visitNode(item, visit)
		return
	}

	const current = node as NodeLike
	if (typeof current.type === 'string') visit(current)

	for (const [key, value] of Object.entries(current)) {
		if (SKIP_KEYS.has(key)) continue
		if (!value || typeof value !== 'object') continue
		visitNode(value, visit)
	}
}
