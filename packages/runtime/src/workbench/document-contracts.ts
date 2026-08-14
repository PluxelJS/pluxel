import {
	assertValidConfigLayout,
	normalizeMarkdownTemplate,
	type ConfigLayoutPart,
} from '@pluxel/core'

export type BuiltinBadgeValue = {
	kind: 'badge'
	label: string
	color?: string
	variant?: 'filled' | 'light' | 'outline' | 'dot'
	size?: 'xs' | 'sm' | 'md' | 'lg'
	radius?: 'xs' | 'sm' | 'md' | 'lg' | 'xl'
}

export type BuiltinValue =
	| string
	| number
	| boolean
	| null
	| BuiltinBadgeValue
	| { kind: 'json'; value: unknown }

export type BuiltinInfoCardRow = {
	label: string
	value: BuiltinValue
	span?: number
}

export type BuiltinInfoCardLayout = {
	variant?: 'list' | 'grid'
	density?: 'comfortable' | 'compact'
	columns?: 1 | 2 | 3 | 4
	labelPlacement?: 'top' | 'left'
	valueAlign?: 'left' | 'right'
}

export type BuiltinDocBlockKind = 'infoCard'

export type BuiltinInfoCardBlock = {
	kind: 'infoCard'
	description?: string
	rows?: BuiltinInfoCardRow[]
	layout?: BuiltinInfoCardLayout
}

export type BuiltinDocBlock = BuiltinInfoCardBlock

export type BuiltinMarkdownPart = ConfigLayoutPart

export type BuiltinDocPart =
	| BuiltinMarkdownPart
	| { kind: 'block'; title: string; block: BuiltinDocBlock }

declare const __builtinDocContentBrand: unique symbol
export type BuiltinDocContent = BuiltinDocPart[] & { readonly [__builtinDocContentBrand]: true }

type BlockDocPart = Extract<BuiltinDocPart, { kind: 'block' }>
type DocInterpolationValue = BuiltinDocPart | string

function isDocPart(value: unknown): value is BuiltinDocPart {
	return (
		!!value &&
		typeof value === 'object' &&
		((value as any).kind === 'md' ||
			(value as any).kind === 'schema' ||
			(value as any).kind === 'schemas' ||
			(value as any).kind === 'block')
	)
}

function assertDocPart(value: unknown): asserts value is BuiltinDocPart {
	if (!isDocPart(value)) {
		throw new Error(
			'[doc] invalid interpolation (expected d.block(...) / d.schema(...) / d.schemas(...), or a markdown string)',
		)
	}
}

function mergeAdjacentMarkdown(parts: BuiltinDocPart[]): BuiltinDocPart[] {
	const merged: BuiltinDocPart[] = []
	for (const part of parts) {
		const prev = merged.at(-1)
		if (part.kind === 'md' && prev?.kind === 'md') {
			merged[merged.length - 1] = { ...prev, text: `${prev.text}${part.text}` }
			continue
		}
		merged.push(part.kind === 'md' ? { ...part } : part)
	}
	return merged
}

function docBlock(title: string, block: BuiltinDocBlock): BlockDocPart {
	const label = String(title ?? '').trim()
	if (!label) throw new Error('[doc.block] title required')
	if (!block || typeof block !== 'object') throw new Error('[doc.block] block required')
	return { kind: 'block', title: label, block }
}

function docCard(input: Omit<BuiltinInfoCardBlock, 'kind'>): BuiltinInfoCardBlock {
	return { kind: 'infoCard', ...(input as any) }
}

function docMarkdown(text: string): BuiltinDocPart {
	const normalized = normalizeMarkdownTemplate(text)
	return { kind: 'md', text: normalized } as BuiltinDocPart
}

function coerceDocInterpolationValue(value: DocInterpolationValue): BuiltinDocPart {
	if (typeof value === 'string') {
		return docMarkdown(value)
	}
	assertDocPart(value)
	if (value.kind === 'md') return docMarkdown(value.text)
	return value
}

type DocBuilder<M extends Record<string, unknown>> = {
	(strings: TemplateStringsArray, ...values: DocInterpolationValue[]): BuiltinDocContent
	block: typeof docBlock
	card: typeof docCard
	/**
	 * Embed config schema editors inside markdown layout (host-rendered):
	 * - `d.schema('k')` renders a single schema key editor
	 * - `d.schemas()` renders remaining schema keys (not yet used in this doc)
	 * - `d.schemas('a','b')` renders the specified keys
	 */
	schema: <K extends Extract<keyof M, string>>(key: K) => BuiltinDocPart
	schemas: <K extends Extract<keyof M, string>>(...keys: readonly K[]) => BuiltinDocPart
}

function createDocBuilder<M extends Record<string, unknown>>(schemaMap: M): DocBuilder<M> {
	if (!schemaMap || typeof schemaMap !== 'object' || Array.isArray(schemaMap)) {
		throw new Error('[doc] doc(schemaMap)`...` requires a plain object schemaMap')
	}

	const tag = (strings: TemplateStringsArray, ...values: DocInterpolationValue[]) => {
		const marker = '\u0000__DOC_VAL__\u0000'
		let raw = ''
		for (let i = 0; i < strings.length; i += 1) {
			raw += strings[i] ?? ''
			if (i < values.length) raw += `${marker}${i}${marker}`
		}
		raw = normalizeMarkdownTemplate(raw)

		const parts: BuiltinDocPart[] = []
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
				throw new Error('[doc] internal interpolation index out of range')
			}
			const inserted = values[idx] as DocInterpolationValue
			parts.push(coerceDocInterpolationValue(inserted))
			last = end
		}
		const tail = raw.slice(last)
		if (tail) parts.push({ kind: 'md', text: tail })
		assertValidConfigLayout(
			parts.filter((part): part is BuiltinMarkdownPart => part.kind !== 'block'),
			{ label: '[doc]' },
		)
		return mergeAdjacentMarkdown(parts) as BuiltinDocContent
	}

	return Object.assign(tag, {
		block: docBlock,
		card: docCard,
		schema: ((key: Extract<keyof M, string>) => {
			const k = String(key ?? '').trim()
			if (!k) throw new Error('[doc.schema] schemaKey required')
			if (!Object.hasOwn(schemaMap, k)) {
				throw new Error(`[doc.schema] unknown schemaKey "${k}" (not in schemaMap)`)
			}
			return { kind: 'schema', key: k } as BuiltinDocPart
		}) as any,
		schemas: ((...keys: readonly Extract<keyof M, string>[]) => {
			const list = (keys ?? []).map((x) => String(x ?? '').trim()).filter(Boolean)
			for (const k of list) {
				if (!Object.hasOwn(schemaMap, k)) {
					throw new Error(`[doc.schemas] unknown schemaKey "${k}" (not in schemaMap)`)
				}
			}
			return { kind: 'schemas', keys: list.length > 0 ? list : null } as BuiltinDocPart
		}) as any,
	}) as unknown as DocBuilder<M>
}

export function doc<M extends Record<string, unknown>>(schemaMap: M): DocBuilder<M> {
	// Factory call: const d = doc(schemaMap); d`...${d.block(...)}...`
	return createDocBuilder(schemaMap)
}
