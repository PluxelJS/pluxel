import { f, v } from '@pluxel/runtime'

export const FONT_MANAGER_PLUGIN_NAME = 'PluginContributionFontManager' as const
export const FONT_KIND = 'font-set' as const

export type FontSet = Readonly<{
	id: string
	name: string
	previewText: string
	description: string
}>

export const FONT_SETS: readonly FontSet[] = Object.freeze([
	Object.freeze({
		id: 'editorial-serif',
		name: 'Editorial Serif',
		previewText: 'The quick brown fox jumps over the lazy dog.',
		description: '适合长文、说明文与强调阅读质感的插件。',
	}),
	Object.freeze({
		id: 'mono-grid',
		name: 'Mono Grid',
		previewText: '0123456789 ABC xyz',
		description: '适合日志、终端、指标与结构化内容场景。',
	}),
	Object.freeze({
		id: 'neo-grotesk',
		name: 'Neo Grotesk',
		previewText: 'Design systems scale through constraints.',
		description: '适合偏产品化、信息密度较高的插件页面。',
	}),
])

export type FontRef = Readonly<{
	provider: string
	kind: string
	id: string
	label?: string
}>

const FontSetRefSchema = v.object({
	provider: v.optional(v.string(), FONT_MANAGER_PLUGIN_NAME),
	kind: v.optional(v.string(), FONT_KIND),
	id: v.optional(v.string(), 'neo-grotesk'),
	label: v.optional(v.string(), 'Neo Grotesk'),
})

export const ConsumerAppearanceConfig = v.object({
	fontSetRef: v.pipe(
		v.optional(v.nullable(FontSetRefSchema), {
			provider: FONT_MANAGER_PLUGIN_NAME,
			kind: FONT_KIND,
			id: 'neo-grotesk',
			label: 'Neo Grotesk',
		}),
		f.formMeta({
			title: '字体集引用',
			description: '配置归 consumer 所有；provider 只提供候选列表与 renderer。',
		}),
	),
})

export function readFontRef(value: unknown): FontRef | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null
	const input = value as Record<string, unknown>
	const provider = readString(input.provider)
	const kind = readString(input.kind)
	const id = readString(input.id)
	const label = readString(input.label)
	if (!provider || !kind || !id) return null
	return Object.freeze({ provider, kind, id, ...(label ? { label } : {}) })
}

export function toFontRef(ref: FontRef): FontRef {
	if (ref.provider !== FONT_MANAGER_PLUGIN_NAME || ref.kind !== FONT_KIND) {
		throw new TypeError('字体引用不属于当前 Font manager')
	}
	const id = readString(ref.id)
	if (!id || id.length > 128) throw new TypeError('字体引用 ID 无效')
	const label = readString(ref.label)
	if (label.length > 128) throw new TypeError('字体引用 label 无效')
	return Object.freeze({
		provider: FONT_MANAGER_PLUGIN_NAME,
		kind: FONT_KIND,
		id,
		...(label ? { label } : {}),
	})
}

function readString(value: unknown): string {
	return typeof value === 'string' ? value.trim() : ''
}
