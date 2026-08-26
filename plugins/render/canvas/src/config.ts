import { f, v } from '@pluxel/runtime'

const MIB = 1024 * 1024

export const CanvasConfig = v.object({
	maxWidth: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(32_768)), 8_192),
		f.formMeta({
			title: 'Maximum width',
			description: 'Maximum width accepted by CanvasPlugin factory and image decoder.',
		}),
	),
	maxHeight: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(32_768)), 8_192),
		f.formMeta({
			title: 'Maximum height',
			description: 'Maximum height accepted by CanvasPlugin factory and image decoder.',
		}),
	),
	maxPixels: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(268_435_456)), 16_777_216),
		f.formMeta({
			title: 'Maximum pixels',
			description: 'Combined width × height budget. The default is 64 MiB of raw RGBA pixels.',
		}),
	),
	maxImageBytes: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(256 * MIB)), 32 * MIB),
		f.formMeta({
			title: 'Maximum encoded image bytes',
			description: 'Maximum byte length accepted by decodeImage().',
		}),
	),
	maxConcurrentDecodes: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(64)), 4),
		f.formMeta({
			title: 'Concurrent image decodes',
			description: 'Maximum native image decodes admitted at once by this Plugin node.',
		}),
	),
	maxQueuedDecodes: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(4_096)), 32),
		f.formMeta({
			title: 'Queued image decodes',
			description: 'Maximum waiting image decodes across all caller Plugins.',
		}),
	),
	maxQueuedDecodesPerConsumer: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(1_024)), 8),
		f.formMeta({
			title: 'Queued decodes per consumer',
			description: 'Maximum waiting image decodes owned by one caller Plugin generation.',
		}),
	),
	maxTextCharacters: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1_000_000)), 100_000),
		f.formMeta({
			title: 'Maximum text characters',
			description: 'Maximum UTF-16 length accepted by one Pretext preparation.',
		}),
	),
	maxRichTextItems: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(16_384)), 2_048),
		f.formMeta({
			title: 'Maximum rich text items',
			description: 'Maximum inline item count accepted by one rich-text preparation.',
		}),
	),
	maxTextCacheCharacters: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(10_000_000)), 1_000_000),
		f.formMeta({
			title: 'Text measurement cache budget',
			description: 'Cumulative prepared characters before shared Pretext caches are reset.',
		}),
	),
})

export type CanvasPluginConfig = v.InferOutput<typeof CanvasConfig>
