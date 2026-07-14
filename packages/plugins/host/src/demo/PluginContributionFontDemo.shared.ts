import { f, v } from '@pluxel/runtime'
import { workbench } from '@pluxel/runtime/workbench'
import type { FontSettingsRpc } from './PluginContributionFontDemo'

export const FONT_MANAGER_PLUGIN_NAME = 'PluginContributionFontManager' as const
export const FONT_KIND = 'font-set' as const

export type FontSetDoc = {
	id: string
	name: string
	previewText: string
	description: string
}

export const FONT_SETS: readonly FontSetDoc[] = [
	{
		id: 'editorial-serif',
		name: 'Editorial Serif',
		previewText: 'The quick brown fox jumps over the lazy dog.',
		description: '适合长文、说明文与强调阅读质感的插件。',
	},
	{
		id: 'mono-grid',
		name: 'Mono Grid',
		previewText: '0123456789 ABC xyz',
		description: '适合日志、终端、指标与结构化内容场景。',
	},
	{
		id: 'neo-grotesk',
		name: 'Neo Grotesk',
		previewText: 'Design systems scale through constraints.',
		description: '适合偏产品化、信息密度较高的插件页面。',
	},
] as const

export type FontRef = {
	provider: string
	kind: string
	id: string
	label?: string
}

export const FontSettingsPort = workbench.port.define('pluxel.demo.font-settings', {
	settings: workbench.model.rpc<FontSettingsRpc>(),
})

const FontSetRefSchema = v.object({
	provider: v.pipe(v.optional(v.string(), FONT_MANAGER_PLUGIN_NAME), f.stringMeta({})),
	kind: v.pipe(v.optional(v.string(), FONT_KIND), f.stringMeta({})),
	id: v.pipe(v.optional(v.string(), 'neo-grotesk'), f.stringMeta({})),
	label: v.pipe(v.optional(v.string(), 'Neo Grotesk'), f.stringMeta({})),
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
			label: '字体集引用',
			description: '配置归 consumer 所有；provider 只提供 renderer 和候选字体集合。',
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
	return { provider, kind, id, ...(label ? { label } : {}) }
}

export function toFontRef(ref: FontRef): FontRef {
	return {
		provider: ref.provider,
		kind: FONT_KIND,
		id: ref.id,
		...(ref.label ? { label: ref.label } : {}),
	}
}

function readString(value: unknown): string {
	return typeof value === 'string' ? value.trim() : ''
}
