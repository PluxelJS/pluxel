import { f, v } from '@pluxel/runtime/config'
import { defineInteractionContract } from '@pluxel/runtime/web/extensions'

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

export type FontPickerInput = {
	current: FontRef | null
}

export type FontPickerDraft = {
	selectedId: string | null
}

export type FontRef = {
	provider: string
	kind: string
	id: string
	label?: string
}

export type FontPickerResult =
	| {
			type: 'set-font'
			ref: FontRef
	  }
	| {
			type: 'clear-font'
	  }

export const FontPickerContract = defineInteractionContract<
	FontPickerInput,
	FontPickerDraft,
	FontPickerResult
>({
	id: 'pluxel.demo.font-picker',
	version: 1,
	label: 'Font Picker',
	validateInput(value) {
		const current = readFontRef(isRecord(value) ? value.current : undefined)
		return { current }
	},
	validateDraft(value) {
		const selectedId = isRecord(value) ? value.selectedId : undefined
		return {
			selectedId: typeof selectedId === 'string' && selectedId.trim() ? selectedId.trim() : null,
		}
	},
	validateResult(value) {
		if (isRecord(value) && value.type === 'clear-font') {
			return { type: 'clear-font' } satisfies FontPickerResult
		}
		const ref = readFontRef(isRecord(value) ? value.ref : undefined)
		if (!ref) throw new Error('Font picker result requires a valid ref')
		return {
			type: 'set-font',
			ref: toFontRef(ref),
		} satisfies FontPickerResult
	},
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
			description: '这个字段始终归 consumer 所有；provider 只提供 UI 和资源集合。',
		}),
	),
})

export function readFontRef(value: unknown): FontPickerInput['current'] {
	if (!isRecord(value)) return null
	const provider = readString(value, 'provider')
	const kind = readString(value, 'kind')
	const id = readString(value, 'id')
	const label = readString(value, 'label')
	if (!provider || !kind || !id) return null
	return {
		provider,
		kind,
		id,
		...(label ? { label } : {}),
	}
}

export function toFontRef(ref: FontRef): FontRef {
	return {
		provider: ref.provider,
		kind: FONT_KIND,
		id: ref.id,
		...(ref.label ? { label: ref.label } : {}),
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function readString(value: Record<string, unknown>, key: string) {
	const raw = value[key]
	return typeof raw === 'string' ? raw.trim() : ''
}

declare module '@pluxel/runtime/web/ui' {
	interface ExtensionUiSignalDbMap {
		PluginContributionFontManager: {
			fontSets: FontSetDoc
		}
	}
}
