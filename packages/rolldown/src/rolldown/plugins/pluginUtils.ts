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

type ParsedProgramCacheEntry = Readonly<{
	code: string
	program: Program
}>

// All Pluxel source passes are read-only AST consumers. Keep the most recent parse for each
// module so the semantic, config, and route-specific passes do not ask OXC to parse identical
// source independently. Exact source equality makes invalidation automatic in Vite/watch mode;
// the bound prevents a long-lived development server from retaining every module revision.
const PARSED_PROGRAM_CACHE_LIMIT = 256
const parsedProgramCache = new Map<string, ParsedProgramCacheEntry>()

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
	const lang = getLangFromId(id)
	const cached = readCachedProgram(id, lang, code)
	if (cached) return cached
	const parse = (ctx as { parse?: (code: string, opts?: unknown) => Program } | null)?.parse
	if (typeof parse === 'function') {
		try {
			return cacheProgram(id, lang, code, parse.call(ctx, code, { lang }) as Program)
		} catch {
			try {
				return cacheProgram(id, lang, code, parse.call(ctx, code) as Program)
			} catch {
				// Fall through to standalone OXC parsers below.
			}
		}
	}

	return parseStandaloneWithLang(code, id)
}

export function parseStandaloneWithLang(code: string, id: string): Program | null {
	const lang = getLangFromId(id)
	const cached = readCachedProgram(id, lang, code)
	if (cached) return cached

	try {
		const program = parseSync(id, code, { sourceType: 'module', lang }).program ?? null
		return program ? cacheProgram(id, lang, code, program) : null
	} catch {
		return null
	}
}

function readCachedProgram(id: string, lang: Lang, code: string): Program | undefined {
	const key = `${lang}\0${id}`
	const cached = parsedProgramCache.get(key)
	if (!cached || cached.code !== code) return undefined
	// Refresh insertion order so active modules survive bounded eviction.
	parsedProgramCache.delete(key)
	parsedProgramCache.set(key, cached)
	return cached.program
}

function cacheProgram(id: string, lang: Lang, code: string, program: Program): Program {
	const key = `${lang}\0${id}`
	parsedProgramCache.delete(key)
	parsedProgramCache.set(key, { code, program })
	while (parsedProgramCache.size > PARSED_PROGRAM_CACHE_LIMIT) {
		const oldest = parsedProgramCache.keys().next().value
		if (oldest === undefined) break
		parsedProgramCache.delete(oldest)
	}
	return program
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
