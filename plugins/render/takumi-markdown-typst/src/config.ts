import { f, v } from '@pluxel/runtime'

const MIB = 1024 * 1024

export const TypstMathConfig = v.object({
	maxFormulas: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(256)), 32),
		f.formMeta({
			title: 'Maximum formulas',
			description: 'Maximum inline and display formulas compiled during one Markdown render.',
		}),
	),
	maxFormulaCharacters: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(32_768)), 4_096),
		f.formMeta({
			title: 'Maximum formula characters',
			description: 'Maximum characters accepted from one restricted Typst math formula.',
		}),
	),
	maxSvgBytes: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(8 * MIB)), MIB),
		f.formMeta({
			title: 'Maximum formula SVG bytes',
			description: 'Maximum SVG bytes returned by the Typst worker for one formula.',
		}),
	),
	maxTotalSvgBytes: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(32 * MIB)), 4 * MIB),
		f.formMeta({
			title: 'Maximum formula SVG bytes per render',
			description: 'Maximum combined SVG bytes generated during one Markdown render.',
		}),
	),
})

export type TypstMathPluginConfig = v.InferOutput<typeof TypstMathConfig>

export type TypstMathLimits = Readonly<
	Pick<
		TypstMathPluginConfig,
		'maxFormulas' | 'maxFormulaCharacters' | 'maxSvgBytes' | 'maxTotalSvgBytes'
	>
>

export function createTypstMathLimits(config: TypstMathPluginConfig): TypstMathLimits {
	return Object.freeze({
		maxFormulas: config.maxFormulas,
		maxFormulaCharacters: config.maxFormulaCharacters,
		maxSvgBytes: config.maxSvgBytes,
		maxTotalSvgBytes: config.maxTotalSvgBytes,
	})
}
