import type { Program } from 'oxc-parser'
import { type AstNode, readLiteralString, walkAst } from './pluginUtils.ts'

export type CollectedImportKind = 'static' | 'dynamic'

export interface CollectedImportSpecifier {
	specifier: string
	kind: CollectedImportKind
	start?: number
	end?: number
}

export function collectImportSpecifiers(ast: Program): CollectedImportSpecifier[] {
	const out: CollectedImportSpecifier[] = []

	for (const statement of ast.body ?? []) {
		if (!statement || typeof statement !== 'object') continue
		const node = statement as AstNode
		if (
			node.type === 'ImportDeclaration' ||
			node.type === 'ExportNamedDeclaration' ||
			node.type === 'ExportAllDeclaration'
		) {
			const specifier = readLiteralString((node as { source?: unknown }).source)
			if (specifier) out.push(withRange({ specifier, kind: 'static' }, node.source))
		}
	}

	walkAst(ast, (node) => {
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
	const value = node as AstNode
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
