import type { Program } from 'oxc-parser'

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
	if (typeof parse !== 'function') return null
	try {
		return parse.call(ctx, code, { lang: getLangFromId(id) }) as Program
	} catch {
		try {
			return parse.call(ctx, code) as Program
		} catch {
			return null
		}
	}
}
