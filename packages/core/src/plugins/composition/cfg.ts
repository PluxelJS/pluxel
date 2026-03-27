import type { StandardSchemaV1 } from '@standard-schema/spec'

type CfgSchemaMap = Record<string, StandardSchemaV1>

export type ConfigLayoutPart =
	| { readonly kind: 'md'; readonly text: string }
	| { readonly kind: 'schema'; readonly key: string }
	| { readonly kind: 'schemas'; readonly keys: readonly string[] | null } // null => remaining

export type ConfigLayout = readonly ConfigLayoutPart[]
export type ConfigLayoutDirectivePart = Extract<ConfigLayoutPart, { readonly kind: 'schema' | 'schemas' }>

export function assertValidConfigLayout(
	layout: ConfigLayout,
	options?: { label?: string },
): void {
	const label = String(options?.label ?? '[cfg]')
	const placed = new Set<string>()
	let hasRemaining = false

	for (const part of layout) {
		if (part.kind === 'md') continue

		if (hasRemaining) {
			throw new Error(`${label} schemas() must be the last schema-placement token`)
		}

		if (part.kind === 'schema') {
			const key = String(part.key ?? '').trim()
			if (placed.has(key)) {
				throw new Error(`${label} duplicate schema placement for key "${key}"`)
			}
			placed.add(key)
			continue
		}

		if (part.keys === null) {
			hasRemaining = true
			continue
		}

		for (const rawKey of part.keys) {
			const key = String(rawKey ?? '').trim()
			if (!key) continue
			if (placed.has(key)) {
				throw new Error(`${label} duplicate schema placement for key "${key}"`)
			}
			placed.add(key)
		}
	}
}

export type CfgDecl<T extends CfgSchemaMap> = {
	readonly kind: 'cfg'
	readonly schemaMap: T
	/** Optional static cfg layout, extracted by toolchains and rendered by the host. */
	readonly layout?: ConfigLayout
}

const CFG_TOKEN_BRAND: unique symbol = Symbol.for('pluxel:cfg:token') as any
type CfgToken =
	| { readonly kind: 'schema'; readonly key: string; readonly [CFG_TOKEN_BRAND]: true }
	| { readonly kind: 'schemas'; readonly keys: readonly string[] | null; readonly [CFG_TOKEN_BRAND]: true }

type CfgBuilder<T extends CfgSchemaMap> = CfgDecl<T> & ((
	strings: TemplateStringsArray,
	...values: readonly CfgToken[]
) => CfgDecl<T>) & {
	schema: <K extends Extract<keyof T, string>>(key: K) => CfgToken
	schemas: <K extends Extract<keyof T, string>>(...keys: readonly K[]) => CfgToken
}

export function normalizeMarkdownTemplate(input: string): string {
	const lines = input.replace(/\r\n/g, '\n').split('\n')
	while (lines.length && lines[0]?.trim() === '') lines.shift()
	while (lines.length && lines[lines.length - 1]?.trim() === '') lines.pop()
	let minIndent = Number.POSITIVE_INFINITY
	for (const line of lines) {
		if (!line.trim()) continue
		const match = line.match(/^[\t ]+/)
		const indent = match ? match[0].length : 0
		minIndent = Math.min(minIndent, indent)
	}
	if (!Number.isFinite(minIndent) || minIndent <= 0) return lines.join('\n')
	return lines.map((line) => (line.trim() ? line.slice(minIndent) : '')).join('\n')
}

export const cfg: {
	<M extends CfgSchemaMap>(schemaMap: M): CfgBuilder<M>
} = Object.assign(
	((schemaMap: CfgSchemaMap) => {
		if (!schemaMap || typeof schemaMap !== 'object' || Array.isArray(schemaMap)) {
			throw new Error('[cfg] cfg(schemaMap) requires a plain object schemaMap')
		}
		const toToken = (t: unknown): CfgToken => {
			if (!t || typeof t !== 'object') {
				throw new Error(
					'[cfg] invalid interpolation (use c.schema(key) / c.schemas(...keys) only)',
				)
			}
			if (!(t as any)[CFG_TOKEN_BRAND]) {
				throw new Error(
					'[cfg] invalid interpolation (use c.schema(key) / c.schemas(...keys) only)',
				)
			}
			return t as CfgToken
		}

		const assertKnownKey = (key: string, label: string) => {
			const k = String(key ?? '').trim()
			if (!k) throw new Error(`[cfg] ${label}: key required`)
			// Help catch casts and out-of-sync schemaMaps in JS at runtime.
			if (!Object.prototype.hasOwnProperty.call(schemaMap, k)) {
				throw new Error(`[cfg] ${label}: unknown schemaKey "${k}" (not in schemaMap)`)
			}
			return k
		}

		const schemaToken = (key: string): CfgToken =>
			({
				kind: 'schema',
				key: assertKnownKey(key, 'schema(key)'),
				[CFG_TOKEN_BRAND]: true,
			} as const)

		const schemasToken = (keys: readonly string[] | null): CfgToken =>
			({ kind: 'schemas', keys, [CFG_TOKEN_BRAND]: true } as const)

		const tokenToPart = (t: CfgToken): ConfigLayoutPart => {
			if (t.kind === 'schema') {
				return { kind: 'schema', key: String(t.key ?? '').trim() }
			}
			if (t.kind === 'schemas') {
				const list =
					t.keys === null
						? null
						: Array.isArray(t.keys)
							? t.keys.map((x) => String(x).trim()).filter(Boolean)
							: []
				if (list !== null) {
					for (const k of list) assertKnownKey(k, 'schemas(...keys)')
				}
				return { kind: 'schemas', keys: list }
			}
			throw new Error('[cfg] invalid token')
		}

		const mergeAdjacentMarkdown = (parts: ConfigLayoutPart[]): ConfigLayoutPart[] => {
			const merged: ConfigLayoutPart[] = []
			for (const part of parts) {
				const prev = merged[merged.length - 1]
				if (part.kind === 'md' && prev?.kind === 'md') {
					;(prev as any).text += part.text
					continue
				}
				merged.push(part.kind === 'md' ? ({ ...part } as any) : part)
			}
			return merged
		}

		const tag = ((strings: TemplateStringsArray, ...values: readonly unknown[]) => {
			// Keep cfg as a static, extractable anchor:
			// - schemaMap is extracted by the build plugin
			// - template is optional markdown fragments
			// - interpolation is allowed only for cfg tokens (schema/schemas)
			const marker = '\u0000__CFG_VAL__\u0000'
			let raw = ''
			for (let i = 0; i < strings.length; i += 1) {
				raw += strings[i] ?? ''
				if (i < values.length) raw += `${marker}${i}${marker}`
			}

			raw = normalizeMarkdownTemplate(raw)

			const parts: ConfigLayoutPart[] = []
			const re = new RegExp(`${marker}(\\d+)${marker}`, 'g')
			let last = 0
			for (;;) {
				const match = re.exec(raw)
				if (!match) break
				const start = match.index
				const end = start + match[0].length
				const chunk = raw.slice(last, start)
				if (chunk) parts.push({ kind: 'md', text: chunk })
				const idx = Number(match[1])
				if (!Number.isInteger(idx) || idx < 0 || idx >= values.length) {
					throw new Error('[cfg] internal interpolation index out of range')
				}
				const inserted = toToken(values[idx])
				parts.push(tokenToPart(inserted))
				last = end
			}
			const tail = raw.slice(last)
			if (tail) parts.push({ kind: 'md', text: tail })

			const merged = mergeAdjacentMarkdown(parts)
			assertValidConfigLayout(merged, { label: '[cfg]' })
			return merged.length
				? ({ kind: 'cfg', schemaMap, layout: merged } as CfgDecl<typeof schemaMap>)
				: ({ kind: 'cfg', schemaMap } as CfgDecl<typeof schemaMap>)
		}) as any

		const schema = <K extends Extract<keyof typeof schemaMap, string>>(key: K): CfgToken =>
			schemaToken(String(key))
		const schemas = <K extends Extract<keyof typeof schemaMap, string>>(
			...keys: readonly K[]
		): CfgToken =>
			keys.length
				? schemasToken(keys.map((k) => assertKnownKey(String(k), 'schemas(...keys)')))
				: schemasToken(null)

		return Object.assign(tag, { kind: 'cfg', schemaMap, schema, schemas }) as CfgBuilder<
			typeof schemaMap
		>
	}) as any,
	{},
)
