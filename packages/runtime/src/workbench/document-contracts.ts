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

export type BuiltinInfoCardBlock = {
	kind: 'infoCard'
	description?: string
	rows?: BuiltinInfoCardRow[]
	layout?: BuiltinInfoCardLayout
}

export type BuiltinDocBlock = BuiltinInfoCardBlock
export type BuiltinMarkdownPart = { kind: 'md'; text: string }
export type BuiltinDocPart =
	| BuiltinMarkdownPart
	| { kind: 'block'; title: string; block: BuiltinDocBlock }

declare const __builtinDocContentBrand: unique symbol
export type BuiltinDocContent = BuiltinDocPart[] & { readonly [__builtinDocContentBrand]: true }

type BlockDocPart = Extract<BuiltinDocPart, { kind: 'block' }>
type DocInterpolationValue = BuiltinDocPart | string

function normalizeMarkdown(text: string): string {
	const value = String(text).replaceAll('\r\n', '\n')
	const lines = value.split('\n')
	while (lines[0]?.trim() === '') lines.shift()
	while (lines.at(-1)?.trim() === '') lines.pop()
	const indents = lines
		.filter((line) => line.trim())
		.map((line) => line.match(/^[\t ]*/)?.[0].length ?? 0)
	const indent = indents.length > 0 ? Math.min(...indents) : 0
	return lines.map((line) => line.slice(indent)).join('\n')
}

function isDocPart(value: unknown): value is BuiltinDocPart {
	return (
		!!value &&
		typeof value === 'object' &&
		((value as { kind?: unknown }).kind === 'md' || (value as { kind?: unknown }).kind === 'block')
	)
}

function docBlock(title: string, block: BuiltinDocBlock): BlockDocPart {
	const label = String(title ?? '').trim()
	if (!label) throw new Error('[doc.block] title required')
	if (!block || typeof block !== 'object') throw new Error('[doc.block] block required')
	return { kind: 'block', title: label, block }
}

function docCard(input: Omit<BuiltinInfoCardBlock, 'kind'>): BuiltinInfoCardBlock {
	return { kind: 'infoCard', ...input }
}

function markdown(value: string): BuiltinMarkdownPart {
	return { kind: 'md', text: normalizeMarkdown(value) }
}

type DocBuilder = {
	(strings: TemplateStringsArray, ...values: DocInterpolationValue[]): BuiltinDocContent
	block: typeof docBlock
	card: typeof docCard
}

/** Generic Workbench document builder. Config schema placement is intentionally not part of it. */
export function doc(): DocBuilder {
	const tag = (strings: TemplateStringsArray, ...values: DocInterpolationValue[]) => {
		const parts: BuiltinDocPart[] = []
		for (let index = 0; index < strings.length; index++) {
			const text = normalizeMarkdown(strings[index] ?? '')
			if (text) parts.push(markdown(text))
			if (index >= values.length) continue
			const value = values[index]!
			if (typeof value === 'string') parts.push(markdown(value))
			else if (isDocPart(value)) parts.push(value.kind === 'md' ? markdown(value.text) : value)
			else throw new Error('[doc] interpolation must be markdown text or d.block(...)')
		}
		const merged: BuiltinDocPart[] = []
		for (const part of parts) {
			const previous = merged.at(-1)
			if (part.kind === 'md' && previous?.kind === 'md') previous.text += part.text
			else merged.push(part)
		}
		return merged as BuiltinDocContent
	}
	return Object.assign(tag, { block: docBlock, card: docCard })
}
