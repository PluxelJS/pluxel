import { parseSync, type Program } from 'oxc-parser'

export type AstNode = {
	type?: unknown
	start?: unknown
	end?: unknown
	[key: string]: unknown
}

const AST_METADATA_KEYS = new Set([
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

export type Lang = 'ts' | 'tsx' | 'js' | 'jsx'

export function getLangFromId(id: string): Lang {
	if (id.endsWith('.tsx')) return 'tsx'
	if (id.endsWith('.ts') || id.endsWith('.mts') || id.endsWith('.cts')) return 'ts'
	if (id.endsWith('.jsx')) return 'jsx'
	return 'js'
}

export function normalizePatterns(
	value: string | string[] | undefined,
	fallback: string[],
): string[] {
	if (Array.isArray(value)) return value
	if (typeof value === 'string') return [value]
	return fallback
}

export function parseWithLang(ctx: unknown, code: string, id: string): Program | null {
	const parse = (ctx as { parse?: (code: string, opts?: unknown) => Program } | null)?.parse
	if (typeof parse === 'function') {
		try {
			return parse.call(ctx, code, { lang: getLangFromId(id) }) as Program
		} catch {
			try {
				return parse.call(ctx, code) as Program
			} catch {
				// Fall through to standalone OXC parsers below.
			}
		}
	}

	return parseStandaloneWithLang(code, id)
}

export function parseStandaloneWithLang(code: string, id: string): Program | null {
	const lang = getLangFromId(id)

	try {
		return parseSync(id, code, { sourceType: 'module', lang }).program ?? null
	} catch {
		return null
	}
}

export function walkAst(value: unknown, visit: (node: AstNode) => void): void {
	if (!value || typeof value !== 'object') return
	if (Array.isArray(value)) {
		for (const item of value) walkAst(item, visit)
		return
	}
	const node = value as AstNode
	if (typeof node.type === 'string') visit(node)
	for (const [key, child] of Object.entries(node)) {
		if (!AST_METADATA_KEYS.has(key) && child && typeof child === 'object') walkAst(child, visit)
	}
}

export function readLiteralString(value: unknown): string | undefined {
	if (!value || typeof value !== 'object') return undefined
	const node = value as { type?: unknown; value?: unknown }
	return node.type === 'Literal' && typeof node.value === 'string' ? node.value : undefined
}

export function readIdentifier(value: unknown): string | undefined {
	if (!value || typeof value !== 'object') return undefined
	const node = value as { type?: unknown; name?: unknown }
	return node.type === 'Identifier' && typeof node.name === 'string' ? node.name : undefined
}
