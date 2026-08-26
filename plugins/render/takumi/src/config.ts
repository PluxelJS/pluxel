import { f, v } from '@pluxel/runtime'

const MIB = 1024 * 1024

export const TakumiConfig = v.object({
	defaultDevicePixelRatio: v.pipe(
		v.optional(v.pipe(v.number(), v.minValue(0.25), v.maxValue(8)), 1),
		f.formMeta({
			title: 'Default device pixel ratio',
			description: 'Pixel ratio used when a render call omits devicePixelRatio.',
		}),
	),
	maxDevicePixelRatio: v.pipe(
		v.optional(v.pipe(v.number(), v.minValue(0.25), v.maxValue(8)), 4),
		f.formMeta({
			title: 'Maximum device pixel ratio',
			description: 'Host ceiling for per-render devicePixelRatio.',
		}),
	),
	maxWidth: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(32_768)), 8_192),
		f.formMeta({
			title: 'Maximum physical width',
			description: 'Maximum width after applying devicePixelRatio.',
		}),
	),
	maxHeight: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(32_768)), 8_192),
		f.formMeta({
			title: 'Maximum physical height',
			description: 'Maximum height after applying devicePixelRatio.',
		}),
	),
	maxPixels: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(268_435_456)), 16_777_216),
		f.formMeta({
			title: 'Maximum physical pixels',
			description: 'Combined physical width × height budget.',
		}),
	),
	maxContentBytes: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(16 * MIB)), MIB),
		f.formMeta({
			title: 'Maximum content bytes',
			description: 'Maximum UTF-8 and structural payload of one HTML or node-tree input.',
		}),
	),
	maxContentNodes: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100_000)), 10_000),
		f.formMeta({
			title: 'Maximum content nodes',
			description: 'Maximum normalized Takumi nodes in one render.',
		}),
	),
	maxTextCharacters: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(10_000_000)), 1_000_000),
		f.formMeta({
			title: 'Maximum text characters',
			description: 'Maximum combined UTF-16 text length in one normalized node tree.',
		}),
	),
	maxStylesheetBytes: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(16 * MIB)), MIB),
		f.formMeta({
			title: 'Maximum stylesheet bytes',
			description: 'Maximum combined UTF-8 bytes of explicit and HTML-extracted stylesheets.',
		}),
	),
	maxStylesheets: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(1_024)), 64),
		f.formMeta({
			title: 'Maximum stylesheets',
			description: 'Maximum number of explicit and HTML-extracted stylesheets in one render.',
		}),
	),
	maxImageBytes: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(256 * MIB)), 32 * MIB),
		f.formMeta({
			title: 'Maximum image bytes',
			description: 'Maximum combined bytes of preloaded and inline image sources per render.',
		}),
	),
	maxImages: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(4_096)), 256),
		f.formMeta({
			title: 'Maximum image sources',
			description: 'Maximum number of explicit or content-referenced image sources in one render.',
		}),
	),
	maxFontBytes: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1024 * MIB)), 128 * MIB),
		f.formMeta({
			title: 'Maximum portable font bytes',
			description:
				'Maximum FontsPlugin byte snapshot replayed into one Takumi renderer generation.',
		}),
	),
	maxFonts: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(4_096)), 256),
		f.formMeta({
			title: 'Maximum portable fonts',
			description: 'Maximum FontsPlugin resources replayed into one Takumi renderer generation.',
		}),
	),
	maxOutputBytes: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(512 * MIB)), 64 * MIB),
		f.formMeta({
			title: 'Maximum output bytes',
			description: 'Maximum encoded raster or UTF-8 SVG result returned to a caller.',
		}),
	),
	cacheMaxBytes: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(512 * MIB)), 16 * MIB),
		f.formMeta({
			title: 'Renderer cache bytes',
			description: 'Takumi renderer-local decoded image, SVG raster and stylesheet cache budget.',
		}),
	),
	maxRenderDurationMs: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(300_000)), 30_000),
		f.formMeta({
			title: 'Maximum render duration',
			description: 'Wall-clock deadline in milliseconds, including queue and preparation time.',
		}),
	),
	maxConcurrentRenders: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(64)), 4),
		f.formMeta({
			title: 'Concurrent renders',
			description: 'Maximum Takumi native renders admitted at once by this Plugin node.',
		}),
	),
	maxQueuedRenders: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(4_096)), 32),
		f.formMeta({
			title: 'Queued renders',
			description: 'Maximum waiting renders across all caller Plugins.',
		}),
	),
	maxQueuedRendersPerConsumer: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(1_024)), 8),
		f.formMeta({
			title: 'Queued renders per consumer',
			description: 'Maximum waiting renders owned by one caller Plugin generation.',
		}),
	),
})

export type TakumiPluginConfig = v.InferOutput<typeof TakumiConfig>
