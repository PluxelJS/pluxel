import { f, v } from '@pluxel/runtime'

const MIB = 1024 * 1024

export const TakumiMarkdownConfig = v.object({
	maxSourceBytes: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(16 * MIB)), MIB),
		f.formMeta({
			title: 'Maximum Markdown bytes',
			description: 'Maximum UTF-8 bytes accepted from one Markdown source.',
		}),
	),
	maxAstNodes: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(200_000)), 20_000),
		f.formMeta({
			title: 'Maximum Markdown AST nodes',
			description: 'Maximum MDAST or HAST nodes visited during one render.',
		}),
	),
	maxHtmlBytes: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(16 * MIB)), MIB),
		f.formMeta({
			title: 'Maximum generated HTML bytes',
			description: 'Maximum UTF-8 bytes passed from Markdown conversion to Takumi.',
		}),
	),
	maxExtensions: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(128)), 16),
		f.formMeta({
			title: 'Maximum renderer extensions',
			description: 'Maximum trusted Markdown extensions accepted by one caller-owned renderer.',
		}),
	),
	maxAssets: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(256)), 32),
		f.formMeta({
			title: 'Maximum generated assets',
			description: 'Maximum extension-owned image assets attached to one Markdown render.',
		}),
	),
	maxAssetBytes: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(8 * MIB)), MIB),
		f.formMeta({
			title: 'Maximum generated asset bytes',
			description: 'Maximum bytes in one extension-owned image asset.',
		}),
	),
	maxTotalAssetBytes: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(64 * MIB)), 8 * MIB),
		f.formMeta({
			title: 'Maximum generated asset bytes per render',
			description: 'Maximum combined bytes in extension-owned image assets.',
		}),
	),
	maxCodeBlocks: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(1_024)), 64),
		f.formMeta({
			title: 'Maximum code blocks',
			description: 'Maximum fenced code blocks sent through the built-in highlighter.',
		}),
	),
	maxCodeBlockBytes: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(4 * MIB)), 128 * 1024),
		f.formMeta({
			title: 'Maximum code block bytes',
			description: 'Maximum UTF-8 bytes in one fenced code block.',
		}),
	),
	maxTotalCodeBytes: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(16 * MIB)), 512 * 1024),
		f.formMeta({
			title: 'Maximum code bytes per render',
			description: 'Maximum combined UTF-8 bytes passed to the built-in highlighter.',
		}),
	),
})

export type TakumiMarkdownPluginConfig = v.InferOutput<typeof TakumiMarkdownConfig>

export type MarkdownRenderLimits = Readonly<
	Pick<
		TakumiMarkdownPluginConfig,
		| 'maxSourceBytes'
		| 'maxAstNodes'
		| 'maxHtmlBytes'
		| 'maxAssets'
		| 'maxAssetBytes'
		| 'maxTotalAssetBytes'
		| 'maxCodeBlocks'
		| 'maxCodeBlockBytes'
		| 'maxTotalCodeBytes'
	>
>

export function createMarkdownRenderLimits(
	config: TakumiMarkdownPluginConfig,
): MarkdownRenderLimits {
	return Object.freeze({
		maxSourceBytes: config.maxSourceBytes,
		maxAstNodes: config.maxAstNodes,
		maxHtmlBytes: config.maxHtmlBytes,
		maxAssets: config.maxAssets,
		maxAssetBytes: config.maxAssetBytes,
		maxTotalAssetBytes: config.maxTotalAssetBytes,
		maxCodeBlocks: config.maxCodeBlocks,
		maxCodeBlockBytes: config.maxCodeBlockBytes,
		maxTotalCodeBytes: config.maxTotalCodeBytes,
	})
}
