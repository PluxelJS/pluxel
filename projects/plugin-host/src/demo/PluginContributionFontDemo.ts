import { BasePlugin, Plugin } from '@pluxel/runtime'
import { RpcTarget } from '@pluxel/runtime/capnweb'
import {
	FontConsumerWorkbench,
	FontManagerWorkbench,
	type FontCatalogApi,
	type FontSelectionApi,
} from './PluginContributionFontDemo.workbench'
import {
	ConsumerAppearanceConfig,
	FONT_SETS,
	readFontRef,
	toFontRef,
	type FontRef,
} from './PluginContributionFontDemo.shared'

@Plugin()
export class PluginContributionFontManager extends BasePlugin {
	override init(): void {
		this.ctx.workbench?.publish(FontManagerWorkbench, {
			selection: () => new FontCatalogTarget(),
		})
	}
}

@Plugin()
export class PluginContributionFontConsumer extends BasePlugin {
	readonly config = this.configs.use(ConsumerAppearanceConfig)
	private fontSetRef: FontRef | null = null

	constructor(private readonly fontManager: PluginContributionFontManager) {
		super()
	}

	override init(): void {
		const configured = readFontRef(this.config.fontSetRef)
		this.fontSetRef = configured ? toFontRef(configured) : null
		this.ctx.workbench?.publish(FontConsumerWorkbench, {
			appearanceFont: {
				provider: this.fontManager,
				consumer: () => new FontSelectionTarget(this),
			},
		})
	}

	currentFont(): FontRef | null {
		return readFontRef(this.fontSetRef)
	}

	setFont(ref: FontRef | null): FontRef | null {
		this.fontSetRef = ref ? toFontRef(ref) : null
		return this.currentFont()
	}
}

class FontCatalogTarget extends RpcTarget implements FontCatalogApi {
	list() {
		return FONT_SETS
	}
}

class FontSelectionTarget extends RpcTarget implements FontSelectionApi {
	constructor(private readonly consumer: PluginContributionFontConsumer) {
		super()
	}

	current() {
		return this.consumer.currentFont()
	}

	set(ref: FontRef | null) {
		return this.consumer.setFont(ref)
	}
}
