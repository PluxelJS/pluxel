// Read this when:
// - 你想看最小 `configs.use(...)` + `features.use(...)`
// - 你需要 feature 配置如何归因到父插件配置页

import { BaseFeature, BasePlugin, Plugin } from '@pluxel/runtime'
import { f, v } from '@pluxel/runtime/config'

function booleanField(label: string, description: string, defaultValue: boolean) {
	return v.pipe(
		v.optional(v.boolean(), defaultValue),
		f.formMeta({ label, description }),
		f.booleanMeta({}),
	)
}

function numberField(
	label: string,
	description: string,
	defaultValue: number,
	input: { min: number; max: number; step: number },
) {
	return v.pipe(
		v.optional(v.number(), defaultValue),
		f.formMeta({ label, description }),
		f.numberMeta(input),
	)
}

const PluginConfig = v.object({
	enabled: booleanField('启用插件', '用于演示插件级配置', true),
})

class CacheFeature extends BaseFeature {
	static featureKey = 'cache'

	config = this.configs.use(
		v.object({
			enabled: booleanField('启用缓存', '用于演示 feature.config（归因到父插件配置页）', true),
			ttlMs: numberField('TTL (ms)', '用于演示 feature 多个 schema tab', 5_000, {
				min: 0,
				max: 60_000,
				step: 250,
			}),
		}),
	)
	rules = this.configs.use(
		v.object({
			maxKeys: numberField('最大键数', '用于演示 `feature.rules` tab', 1_000, {
				min: 0,
				max: 100_000,
				step: 100,
			}),
		}),
	)
}

class TelemetryFeature extends BaseFeature {
	static featureKey = 'telemetry'

	config = this.configs.use(
		v.object({
			enabled: booleanField('启用 Telemetry', '用于演示 feature.config', false),
			sampleRate: numberField('采样率', '0~1', 1, { min: 0, max: 1, step: 0.05 }),
		}),
	)
}

@Plugin({ name: 'PluginFeatureConfigDemo' })
export class PluginFeatureConfigDemo extends BasePlugin {
	config = this.configs.use(PluginConfig)
	readonly cache = this.features.use(CacheFeature)
	readonly telemetry = this.features.use(TelemetryFeature)

	override init(): void {
		this.ctx.logger.info('feature config demo', {
			plugin: this.config,
			cache: { config: this.cache.config, rules: this.cache.rules },
			telemetry: this.telemetry.config,
		})
	}
}
