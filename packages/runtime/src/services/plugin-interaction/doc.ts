import type {
	BuiltinDocBlock,
	BuiltinDocContent,
	BuiltinDocPart,
	BuiltinInfoCardBlock,
	BuiltinRpcAutoFormBlock,
} from '../../web/plugin-ui/types'

function normalizeMarkdownTemplate(input: string): string {
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

type BlockDocPart = Extract<BuiltinDocPart, { kind: 'block' }>
type DocValue = BlockDocPart

function isDocPart(value: unknown): value is BuiltinDocPart {
	return (
		!!value &&
		typeof value === 'object' &&
		((value as any).kind === 'md' || (value as any).kind === 'block')
	)
}

function assertBlockDocPart(value: unknown): asserts value is BlockDocPart {
	if (!isDocPart(value) || (value as any).kind !== 'block') {
		throw new Error('[doc] invalid interpolation (expected doc.block(...))')
	}
}

function mergeAdjacentMarkdown(parts: BuiltinDocPart[]): BuiltinDocPart[] {
	const merged: BuiltinDocPart[] = []
	for (const part of parts) {
		const prev = merged[merged.length - 1]
		if (part.kind === 'md' && prev?.kind === 'md') {
			prev.text += part.text
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

function docForm(input: Omit<BuiltinRpcAutoFormBlock, 'kind'>): BuiltinRpcAutoFormBlock {
	return { kind: 'rpcAutoForm', ...(input as any) }
}

/**
 * Builtin doc authoring API (server-safe).
 *
 * This helper mirrors `@pluxel/runtime/web`'s `doc` tagged template but intentionally avoids
 * importing React-heavy UI helpers at runtime so plugin server modules can register builtin docs
 * without paying the browser bundle cost.
 */
export const doc: {
	(strings: TemplateStringsArray, ...values: DocValue[]): BuiltinDocContent
	block: typeof docBlock
	card: typeof docCard
	form: typeof docForm
} = Object.assign(
	(strings: TemplateStringsArray, ...values: DocValue[]) => {
		const marker = '\u0000__DOC_VAL__\u0000'
		let raw = ''
		for (let i = 0; i < strings.length; i++) {
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
			const inserted = values[idx]
			assertBlockDocPart(inserted)
			parts.push(inserted)
			last = end
		}
		const tail = raw.slice(last)
		if (tail) parts.push({ kind: 'md', text: tail })
		return mergeAdjacentMarkdown(parts) as BuiltinDocContent
	},
	{ block: docBlock, card: docCard, form: docForm },
)
