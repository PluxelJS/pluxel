// Read this when:
// - 你需要一个 Plugin 只声明一次完整 object schema
// - 你想把内部模块的配置归入 owner Plugin，而不是创建独立配置命名空间

import { BasePlugin, f, Plugin, v } from '@pluxel/runtime'

const PluginConfig = v.object({
	enabled: v.pipe(
		v.optional(v.boolean(), true),
		f.formMeta({ label: '启用插件', description: '用于演示插件级配置' }),
		f.booleanMeta({}),
	),
	cache: v.object({
		enabled: v.pipe(
			v.optional(v.boolean(), true),
			f.formMeta({
				label: '启用缓存',
				description: '缓存属于 Plugin 的内部组成，配置由 owner Plugin 统一声明',
			}),
			f.booleanMeta({}),
		),
		ttlMs: v.pipe(
			v.optional(v.number(), 5_000),
			f.formMeta({ label: 'TTL (ms)', description: '缓存条目的存活时间' }),
			f.numberMeta({ min: 0, max: 60_000, step: 250 }),
		),
		maxKeys: v.pipe(
			v.optional(v.number(), 1_000),
			f.formMeta({ label: '最大键数', description: '缓存可保留的最大条目数' }),
			f.numberMeta({ min: 0, max: 100_000, step: 100 }),
		),
	}),
	telemetry: v.object({
		enabled: v.pipe(
			v.optional(v.boolean(), false),
			f.formMeta({ label: '启用 Telemetry', description: '启用内部遥测模块' }),
			f.booleanMeta({}),
		),
		sampleRate: v.pipe(
			v.optional(v.number(), 1),
			f.formMeta({ label: '采样率', description: '0~1' }),
			f.numberMeta({ min: 0, max: 1, step: 0.05 }),
		),
	}),
})

@Plugin({ displayName: 'PluginCompositionConfigDemo' })
export class PluginCompositionConfigDemo extends BasePlugin {
	readonly config = this.configs.use(PluginConfig)

	override init(): void {
		this.ctx.logger.info('plugin composition config demo', this.config)
	}
}
