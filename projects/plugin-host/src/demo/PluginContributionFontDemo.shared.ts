import { f, v } from '@pluxel/runtime'
import {
	FONT_KIND,
	FONT_MANAGER_PLUGIN_NAME,
	type FontRef,
} from './PluginContributionFontDemo.contract'
export {
	FONT_KIND,
	FONT_MANAGER_PLUGIN_NAME,
	FONT_SETS,
	FontSettingsPort,
	type FontRef,
	type FontSetDoc,
	type FontSettingsCommands,
} from './PluginContributionFontDemo.contract'

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
