import type {
	ExtensionPoint,
	ExtensionPointMap,
	ExtensionPointMeta,
	UiConfirmPayload,
	UiNotifyPayload,
} from './ui-contracts'

export type BuiltinExtensionKind = 'doc'

type BuiltinMetaProp<P extends ExtensionPoint> = ExtensionPointMap[P] extends { metaRequired: true }
	? { meta: ExtensionPointMeta<P> }
	: { meta?: ExtensionPointMeta<P> }

export type BuiltinExtensionBase<P extends ExtensionPoint = ExtensionPoint> = BuiltinMetaProp<P> & {
	kind: BuiltinExtensionKind
	point: P
	id: string
	pluginName: string
	priority?: number
	requireRunning?: boolean
}

export type BuiltinSignalDbRef<T = unknown> = {
	kind: 'signaldb'
	collection: string
	selector?: Record<string, unknown>
	path?: string
	fallback?: T
}

export type BuiltinSyncRef<T = unknown> = BuiltinSignalDbRef<T>

export type BuiltinFieldValueRef = {
	kind: 'field'
	key: string
}

export type BuiltinGeneratedIdValue = {
	kind: 'generatedId'
}

export type BuiltinNowValue = {
	kind: 'now'
	format?: 'ms' | 'iso'
}

export type BuiltinTemplateValue =
	| null
	| string
	| number
	| boolean
	| BuiltinFieldValueRef
	| BuiltinGeneratedIdValue
	| BuiltinNowValue
	| { [key: string]: BuiltinTemplateValue }
	| BuiltinTemplateValue[]

export type BuiltinSignalDbWriteMode = 'patch' | 'replace' | 'insert' | 'remove'

export type BuiltinSignalDbWriteSpec = {
	collection: string
	mode?: BuiltinSignalDbWriteMode
	selector?: Record<string, unknown>
	upsert?: boolean
	value?: BuiltinTemplateValue
}

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
	| BuiltinSyncRef

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

export type BuiltinDocBlockKind = 'infoCard' | 'form' | 'action'

export type BuiltinInfoCardBlock = {
	kind: 'infoCard'
	description?: string
	rows?: BuiltinInfoCardRow[]
	layout?: BuiltinInfoCardLayout
}

export type BuiltinFormBlock = {
	kind: 'form'
	description?: string
	submitLabel?: string
	submitMode?: 'manual' | 'onChange'
	autoSubmitDebounceMs?: number
	syncFrom?: BuiltinSignalDbRef<Record<string, unknown>>
	schemaKey: string
	write: BuiltinSignalDbWriteSpec
	confirm?: UiConfirmPayload
	feedback?: {
		success?: UiNotifyPayload
		error?: UiNotifyPayload
	}
	resetOnSuccess?: boolean
}

export type BuiltinActionBlock = {
	kind: 'action'
	label: string
	description?: string
	write: BuiltinSignalDbWriteSpec
	confirm?: UiConfirmPayload
	feedback?: {
		success?: UiNotifyPayload
		error?: UiNotifyPayload
	}
}

export type BuiltinDocBlock =
	| BuiltinInfoCardBlock
	| BuiltinFormBlock
	| BuiltinActionBlock

export type BuiltinDocExtensionDef<P extends ExtensionPoint = ExtensionPoint> =
	BuiltinExtensionBase<P> & {
		kind: 'doc'
		title?: string
		description?: string
		content: BuiltinDocContent
	}

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

export type BuiltinDocPart =
	| { kind: 'md'; text: string }
	| { kind: 'block'; title: string; block: BuiltinDocBlock }

declare const __builtinDocContentBrand: unique symbol
export type BuiltinDocContent = BuiltinDocPart[] & { readonly [__builtinDocContentBrand]: true }

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

export const doc: {
	(strings: TemplateStringsArray, ...values: DocValue[]): BuiltinDocContent
	block: typeof docBlock
	card: typeof docCard
} = Object.assign(
	(strings: TemplateStringsArray, ...values: DocValue[]) => {
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
			const inserted = values[idx]
			assertBlockDocPart(inserted)
			parts.push(inserted)
			last = end
		}
		const tail = raw.slice(last)
		if (tail) parts.push({ kind: 'md', text: tail })
		return mergeAdjacentMarkdown(parts) as BuiltinDocContent
	},
	{ block: docBlock, card: docCard },
)

export type BuiltinExtensionDef = BuiltinDocExtensionDef

export interface CompiledExtensionModule {
	pluginName: string
	remoteName: string
	manifestUrl: string
	exposedModule: string
	sourceHash: string
	compiledAt: number
}

export type ExtensionModuleStateKind = 'ready' | 'building' | 'error'

export interface ExtensionModuleState {
	pluginName: string
	state: ExtensionModuleStateKind
	updatedAt: number
	sourceHash?: string
	compiledAt?: number
	message?: string
}

export interface ExtensionManifest {
	version: number
	modules: CompiledExtensionModule[]
	builtins?: BuiltinExtensionDef[]
	states?: ExtensionModuleState[]
}

export type ExtensionManifestEvent =
	| {
			type: 'update'
			version: number
			pluginName: string
			remoteName: string
			manifestUrl: string
			exposedModule: string
			sourceHash: string
			compiledAt: number
	  }
	| {
			type: 'building'
			version: number
			pluginName: string
			updatedAt: number
			sourceHash?: string
			compiledAt?: number
	  }
	| {
			type: 'error'
			version: number
			pluginName: string
			updatedAt: number
			sourceHash?: string
			compiledAt?: number
			message: string
	  }
	| {
			type: 'remove'
			version: number
			pluginName: string
	  }
	| {
			type: 'sync'
			version: number
	  }
