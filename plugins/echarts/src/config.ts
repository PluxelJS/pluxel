import { f, v } from '@pluxel/runtime'

const MIB = 1024 * 1024

export const EChartsConfig = v.object({
	defaultDevicePixelRatio: v.pipe(
		v.optional(v.pipe(v.number(), v.minValue(0.25), v.maxValue(8)), 1),
		f.formMeta({
			label: 'Default device pixel ratio',
			description: 'Pixel ratio used when render() does not provide one.',
		}),
	),
	maxDevicePixelRatio: v.pipe(
		v.optional(v.pipe(v.number(), v.minValue(0.25), v.maxValue(8)), 4),
		f.formMeta({
			label: 'Maximum device pixel ratio',
			description: 'Host ceiling for per-render device pixel ratio.',
		}),
	),
	maxThemesPerConsumer: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(512)), 32),
		f.formMeta({
			label: 'Maximum themes per consumer',
			description: 'Maximum number of caller-owned named themes.',
		}),
	),
	maxThemeBytes: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(16 * MIB)), MIB),
		f.formMeta({
			label: 'Maximum theme bytes',
			description: 'Maximum UTF-8 JSON size of one registered or inline theme.',
		}),
	),
	maxDataUrlBytes: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(256 * MIB)), 32 * MIB),
		f.formMeta({
			label: 'Maximum data URL bytes',
			description: 'Pre-decode byte ceiling for ECharts data URL image sources.',
		}),
	),
})

export type EChartsPluginConfig = v.InferOutput<typeof EChartsConfig>
