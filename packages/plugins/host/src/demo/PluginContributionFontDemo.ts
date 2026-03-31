import { ui } from '@pluxel/hmr/plugin'
import { BasePlugin, Plugin } from '@pluxel/runtime'
import { f, v } from '@pluxel/runtime/config'
import { doc } from '@pluxel/runtime/services'
import { defineInteractionContract } from '@pluxel/runtime/web/extensions'

type FontSetDoc = {
	id: string
	name: string
	previewText: string
	description: string
}

const FONT_SETS: readonly FontSetDoc[] = [
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

const fontContributionUi = ui('./PluginContributionFontDemo/ui/index.tsx')

type FontPickerInput = {
	current: {
		provider: string
		kind: string
		id: string
		label?: string
	} | null
}

type FontPickerDraft = {
	selectedId: string | null
}

type FontPickerResult =
	| {
			type: 'set-font'
			ref: {
				provider: string
				kind: 'font-set'
				id: string
				label?: string
			}
	  }
	| {
			type: 'clear-font'
	  }

const FontPickerContract = defineInteractionContract<
	FontPickerInput,
	FontPickerDraft,
	FontPickerResult
>({
	id: 'pluxel.demo.font-picker',
	version: 1,
	label: 'Font Picker',
	validateInput(value) {
		const current = readFontRef((value as FontPickerInput | null | undefined)?.current)
		return { current }
	},
	validateDraft(value) {
		const selectedId = (value as FontPickerDraft | null | undefined)?.selectedId
		return {
			selectedId: typeof selectedId === 'string' && selectedId.trim() ? selectedId.trim() : null,
		}
	},
	validateResult(value) {
		if (value && typeof value === 'object' && (value as any).type === 'clear-font') {
			return { type: 'clear-font' } satisfies FontPickerResult
		}
		const ref = readFontRef((value as { ref?: unknown } | null | undefined)?.ref)
		if (!ref) throw new Error('Font picker result requires a valid ref')
		return {
			type: 'set-font',
			ref: {
				provider: ref.provider,
				kind: 'font-set',
				id: ref.id,
				...(ref.label ? { label: ref.label } : {}),
			},
		} satisfies FontPickerResult
	},
})

const FontSetRefSchema = v.object({
	provider: v.pipe(v.optional(v.string(), 'PluginContributionFontManager'), f.stringMeta({})),
	kind: v.pipe(v.optional(v.string(), 'font-set'), f.stringMeta({})),
	id: v.pipe(v.optional(v.string(), 'neo-grotesk'), f.stringMeta({})),
	label: v.pipe(v.optional(v.string(), 'Neo Grotesk'), f.stringMeta({})),
})

const ConsumerAppearanceConfig = v.object({
	fontSetRef: v.pipe(
		v.optional(FontSetRefSchema, {
			provider: 'PluginContributionFontManager',
			kind: 'font-set',
			id: 'neo-grotesk',
			label: 'Neo Grotesk',
		}),
		f.formMeta({
			label: '字体集引用',
			description: '这个字段始终归 consumer 所有；provider 只提供 UI 和资源集合。',
		}),
	),
})

@Plugin({ name: 'PluginContributionFontManager' })
export class PluginContributionFontManager extends BasePlugin {
	private readonly fontSets = this.ctx.ext.signaldb.collection<FontSetDoc>({
		name: 'fontSets',
		initial: FONT_SETS.map((item) => ({ ...item })),
	})

	override async init(): Promise<void> {
		await this.fontSets.ready()
		fontContributionUi.bind(this.ctx)
		this.registerOwnInfo()
		this.registerConsumerContribution()
	}

	private registerOwnInfo() {
		const d = doc({} as const)

		this.ctx.ext.ui.builtin.doc({
			id: 'font-manager-overview',
			point: 'plugin:context',
			title: 'Font Sets',
			requireRunning: false,
			content: d`
				${d.block('Available Sets', {
					kind: 'infoCard',
					rows: FONT_SETS.map((item) => ({
						label: item.name,
						value: item.previewText,
					})),
					layout: { variant: 'list', density: 'compact', valueAlign: 'left' },
				})}
			`,
		})
	}

	private registerConsumerContribution() {
		this.ctx.ext.ui.interaction.offer({
			id: 'font-manager-consumer-picker',
			contract: FontPickerContract,
			requireRunning: false,
			priority: 40,
			renderKey: 'fontPickerSession',
			prepare: async ({ input }) => {
				await this.fontSets.ready()
				return {
					draft: {
						selectedId: input.current?.id ?? null,
					} satisfies FontPickerDraft,
				}
			},
		})
	}
}

@Plugin({ name: 'PluginContributionFontConsumer' })
export class PluginContributionFontConsumer extends BasePlugin {
	appearance = this.configs.use(ConsumerAppearanceConfig)

	constructor(_fontManager: PluginContributionFontManager) {
		super()
	}

	override init(): void {
		this.ctx.ext.ui.interaction.surface({
			id: 'appearance.font',
			point: 'plugin:tabs',
			contract: FontPickerContract,
			title: 'Typography',
			providers: ['PluginContributionFontManager'],
			input: () => ({
				current: readFontRef(this.appearance.fontSetRef),
			}),
			apply: async (result) => {
				const nextFontSetRef =
					result.type === 'clear-font'
						? null
						: {
								provider: result.ref.provider,
								kind: result.ref.kind,
								id: result.ref.id,
								...(result.ref.label ? { label: result.ref.label } : {}),
							}
				this.ctx.configService.patchConfig(this.ctx.pluginInfo.id, {
					appearance: {
						fontSetRef: nextFontSetRef,
					},
				})
			},
			meta: {
				label: 'Typography',
				icon: 'typography',
				tab: { id: 'typography', label: 'Typography', icon: 'typography' },
			},
		})
		this.ctx.logger.info('font consumer config', {
			appearance: this.appearance,
		})
	}
}

function readFontRef(value: unknown): FontPickerInput['current'] {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null
	const provider = typeof (value as any).provider === 'string' ? (value as any).provider.trim() : ''
	const kind = typeof (value as any).kind === 'string' ? (value as any).kind.trim() : ''
	const id = typeof (value as any).id === 'string' ? (value as any).id.trim() : ''
	const label =
		typeof (value as any).label === 'string' && (value as any).label.trim()
			? (value as any).label.trim()
			: undefined
	if (!provider || !kind || !id) return null
	return {
		provider,
		kind,
		id,
		...(label ? { label } : {}),
	}
}

declare module '@pluxel/runtime/web/ui' {
	interface ExtensionUiSignalDbMap {
		PluginContributionFontManager: {
			fontSets: FontSetDoc
		}
	}
}
