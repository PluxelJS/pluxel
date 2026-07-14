import { BasePlugin, Plugin } from '@pluxel/runtime'
import { RpcTarget } from '@pluxel/runtime/capnweb'
import { workbench } from '@pluxel/runtime/workbench'
import { FontConsumerUi, FontManagerUi } from './PluginContributionFontDemo.workbench'
import {
	ConsumerAppearanceConfig,
	FONT_SETS,
	readFontRef,
	toFontRef,
	type FontRef,
} from './PluginContributionFontDemo.shared'

const FontManagerWorkbench = workbench.extension({
	contract: FontManagerUi,
	entry: workbench.entry(import.meta.url, './PluginContributionFontDemo/ui/index.tsx'),
})
const FontConsumerWorkbench = workbench.extension({ contract: FontConsumerUi })

@Plugin({ name: 'PluginContributionFontManager' })
export class PluginContributionFontManager extends BasePlugin {
	override async init(): Promise<void> {
		const mounted = this.ctx.workbench.mount(FontManagerWorkbench, {
			fontSets: workbench.bind.managedCollection({
				initial: FONT_SETS.map((item) => Object.assign({}, item)),
			}),
		})
		await mounted?.managedCollections.fontSets?.ready()
	}
}

@Plugin({ name: 'PluginContributionFontConsumer' })
export class PluginContributionFontConsumer extends BasePlugin {
	appearance = this.configs.use(ConsumerAppearanceConfig)

	constructor(_fontManager: PluginContributionFontManager) {
		super()
	}

	override init(): void {
		this.ctx.workbench.mount(FontConsumerWorkbench, {
			commands: workbench.bind.rpc(() => new FontSettingsRpc(this)),
		})
	}

	currentFont(): FontRef | null {
		return readFontRef(this.appearance.fontSetRef)
	}

	setFont(ref: FontRef | null): FontRef | null {
		const value = ref ? toFontRef(ref) : null
		this.ctx.configService.patchConfig(this.ctx.pluginInfo.id, {
			appearance: { fontSetRef: value },
		})
		return value
	}
}

export class FontSettingsRpc extends RpcTarget {
	constructor(private readonly consumer: PluginContributionFontConsumer) {
		super()
	}

	async current() {
		return this.consumer.currentFont()
	}

	async set(ref: FontRef | null) {
		return this.consumer.setFont(ref)
	}
}
