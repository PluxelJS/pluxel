import { BaseFeature, BasePlugin, Plugin } from '@pluxel/hmr'
import { f, v } from '@pluxel/hmr/config'

const PluginConfig = v.object({
	enabled: v.pipe(
		v.optional(v.boolean(), true),
		f.formMeta({ label: '启用插件', description: '用于演示插件级配置' }),
		f.booleanMeta({}),
	),
})

class CacheFeature extends BaseFeature {
	static featureKey = 'cache'

	config = this.configs.use(
		v.object({
			enabled: v.pipe(
				v.optional(v.boolean(), true),
				f.formMeta({
					label: '启用缓存',
					description: '用于演示 feature.config（归因到父插件配置页）',
				}),
				f.booleanMeta({}),
			),
			ttlMs: v.pipe(
				v.optional(v.number(), 5_000),
				f.formMeta({ label: 'TTL (ms)', description: '用于演示 feature 多个 schema tab' }),
				f.numberMeta({ min: 0, max: 60_000, step: 250 }),
			),
		}),
	)
	rules = this.configs.use(
		v.object({
			maxKeys: v.pipe(
				v.optional(v.number(), 1_000),
				f.formMeta({ label: '最大键数', description: '用于演示 `feature.rules` tab' }),
				f.numberMeta({ min: 0, max: 100_000, step: 100 }),
			),
		}),
	)
}

class TelemetryFeature extends BaseFeature {
	static featureKey = 'telemetry'

	config = this.configs.use(
		v.object({
			enabled: v.pipe(
				v.optional(v.boolean(), false),
				f.formMeta({ label: '启用 Telemetry', description: '用于演示 feature.config' }),
				f.booleanMeta({}),
			),
			sampleRate: v.pipe(
				v.optional(v.number(), 1),
				f.formMeta({ label: '采样率', description: '0~1' }),
				f.numberMeta({ min: 0, max: 1, step: 0.05 }),
			),
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
