import type { StandardSchemaV1 } from '@standard-schema/spec'

import { BaseFeature, BasePlugin, HostBoundFeature } from '@pluxel/core/test'

const PassthroughSchema: StandardSchemaV1 = {
	'~standard': {
		version: 1,
		vendor: 'pluxel:test',
		validate: (value: unknown) => ({ value }),
	},
}

export class DepOptionalFeature extends BaseFeature {
	static initCount = 0

	constructor(ctx: BasePlugin['ctx']) {
		super(ctx)
		DepOptionalFeature.initCount += 1
	}

	static reset(): void {
		DepOptionalFeature.initCount = 0
	}
}

export class HostBoundOptionalFeature extends HostBoundFeature<BasePlugin> {
	hostPluginId(): string {
		return this.host.ctx.pluginInfo.id
	}
}

export class InlineOptionalFeature extends BaseFeature {}

export class InvalidOptionalFeature extends BaseFeature {
	cfg = this.configs.use(PassthroughSchema)
}

export class KeyFeatureA extends BaseFeature {}
export class KeyFeatureB extends BaseFeature {}
