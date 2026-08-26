import { f, v } from '@pluxel/runtime'

const MIB = 1024 * 1024

export const EChartsConfig = v.object({
	defaultDevicePixelRatio: v.pipe(
		v.optional(v.pipe(v.number(), v.minValue(0.25), v.maxValue(8)), 1),
		f.formMeta({
			title: 'Default device pixel ratio',
			description: 'Pixel ratio used when render() does not provide one.',
		}),
	),
	maxDevicePixelRatio: v.pipe(
		v.optional(v.pipe(v.number(), v.minValue(0.25), v.maxValue(8)), 4),
		f.formMeta({
			title: 'Maximum device pixel ratio',
			description: 'Host ceiling for per-render device pixel ratio.',
		}),
	),
	maxThemesPerConsumer: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(512)), 32),
		f.formMeta({
			title: 'Maximum themes per consumer',
			description: 'Maximum number of caller-owned named themes.',
		}),
	),
	maxTotalThemes: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(4_096)), 256),
		f.formMeta({
			title: 'Maximum total themes',
			description: 'Maximum caller-owned named themes retained by this Plugin node.',
		}),
	),
	maxTotalThemeBytes: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(256 * MIB)), 16 * MIB),
		f.formMeta({
			title: 'Maximum total theme bytes',
			description: 'Maximum combined JSON bytes retained for all caller-owned named themes.',
		}),
	),
	maxThemeBytes: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(16 * MIB)), MIB),
		f.formMeta({
			title: 'Maximum theme bytes',
			description: 'Maximum UTF-8 JSON size of one registered or inline theme.',
		}),
	),
	maxThemeNodes: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100_000)), 20_000),
		f.formMeta({
			title: 'Maximum theme values',
			description: 'Maximum number of values visited in one registered or inline theme.',
		}),
	),
	maxThemeDepth: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(256)), 64),
		f.formMeta({
			title: 'Maximum theme depth',
			description: 'Maximum object and array nesting depth in one registered or inline theme.',
		}),
	),
	maxDataUrlBytes: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(256 * MIB)), 32 * MIB),
		f.formMeta({
			title: 'Maximum data URL bytes',
			description: 'Maximum decoded bytes accepted from one ECharts data URL image source.',
		}),
	),
	maxImages: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(4_096)), 32),
		f.formMeta({
			title: 'Maximum image sources',
			description: 'Maximum distinct data URL image sources used by one render.',
		}),
	),
	maxTotalImageBytes: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1024 * MIB)), 32 * MIB),
		f.formMeta({
			title: 'Total image source bytes',
			description: 'Maximum combined decoded data URL bytes used by one render.',
		}),
	),
	maxTotalImagePixels: v.pipe(
		v.optional(
			v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1_073_741_824)),
			67_108_864,
		),
		f.formMeta({
			title: 'Total decoded image pixels',
			description: 'Maximum combined decoded pixels retained by one render.',
		}),
	),
	maxOptionBytes: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(256 * MIB)), 8 * MIB),
		f.formMeta({
			title: 'Maximum option bytes',
			description: 'Maximum estimated structured-clone payload for one declarative ECharts option.',
		}),
	),
	maxOptionNodes: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1_000_000)), 100_000),
		f.formMeta({
			title: 'Maximum option values',
			description: 'Maximum number of values visited in one declarative ECharts option.',
		}),
	),
	maxOptionDepth: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(256)), 64),
		f.formMeta({
			title: 'Maximum option depth',
			description: 'Maximum object and array nesting depth in one ECharts option.',
		}),
	),
	maxOutputBytes: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(512 * MIB)), 64 * MIB),
		f.formMeta({
			title: 'Maximum output bytes',
			description: 'Maximum encoded raster result returned from the worker.',
		}),
	),
})

export type EChartsPluginConfig = v.InferOutput<typeof EChartsConfig>
