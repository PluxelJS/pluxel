// Read this when:
// - 你要做跨插件 interaction
// - 你要看 consumer 拥有 config，provider 拥有资源和 session UI 的推荐分工

import { ui } from '@pluxel/runtime-dynamic/plugin'
import { BasePlugin, Plugin } from '@pluxel/runtime'
import { doc } from '@pluxel/runtime/services'
import {
	ConsumerAppearanceConfig,
	FONT_MANAGER_PLUGIN_NAME,
	FONT_SETS,
	FontPickerContract,
	readFontRef,
	toFontRef,
	type FontPickerDraft,
	type FontSetDoc,
} from './PluginContributionFontDemo.shared'

const fontContributionUi = ui('./PluginContributionFontDemo/ui/index.tsx')

// Provider owns resources plus the session UI.
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

// Consumer owns config and the interaction surface placement.
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
			providers: [FONT_MANAGER_PLUGIN_NAME],
			input: () => ({
				current: readFontRef(this.appearance.fontSetRef),
			}),
			apply: async (result) => {
				this.ctx.configService.patchConfig(this.ctx.pluginInfo.id, {
					appearance: {
						fontSetRef: result.type === 'clear-font' ? null : toFontRef(result.ref),
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
