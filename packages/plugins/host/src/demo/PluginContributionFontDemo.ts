import { BasePlugin, Plugin } from '@pluxel/runtime'
import { RpcTarget } from '@pluxel/runtime/capnweb'
import { managementBinding } from '@pluxel/runtime/management'
import {
	FontConsumerManagement,
	FontManagerManagement,
} from './PluginContributionFontDemo.management'
import {
	ConsumerAppearanceConfig,
	FONT_SETS,
	readFontRef,
	toFontRef,
	type FontRef,
} from './PluginContributionFontDemo.shared'

@Plugin({ name: 'PluginContributionFontManager' })
export class PluginContributionFontManager extends BasePlugin {
	override async init(): Promise<void> {
		const mounted = this.ctx.management.mount(FontManagerManagement, {
			fontSets: managementBinding.collection({
				initial: FONT_SETS.map((item) => Object.assign({}, item)),
			}),
		})
		await mounted?.resources.fontSets.ready()
	}
}

@Plugin({ name: 'PluginContributionFontConsumer' })
export class PluginContributionFontConsumer extends BasePlugin {
	appearance = this.configs.use(ConsumerAppearanceConfig)

	constructor(_fontManager: PluginContributionFontManager) {
		super()
	}

	override init(): void {
		this.ctx.management.mount(FontConsumerManagement, {
			settings: managementBinding.api(() => new FontSettingsRpc(this)),
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
