import type { TypstPlugin } from '@pluxel/plugin-typst'
import type { TakumiMarkdownPluginConfig } from './config.ts'
import { MarkdownError } from './errors.ts'
import { createTypstMathSource, validateTypstMathFormula } from './formula.ts'
import type { MarkdownExtension } from './index.ts'
import { MARKDOWN_FOREGROUND } from './styles.ts'

/** The Markdown renderer owns cancellation and pending work; Typst owns compilation and Workers. */
export function createTypstMathExtension(
	typst: Pick<TypstPlugin, 'renderSvg'>,
	limits: Readonly<TakumiMarkdownPluginConfig['math']>,
): MarkdownExtension {
	return Object.freeze({
		name: 'pluxel-typst-math',
		requiredFeatures: Object.freeze({ math: true }),
		create(context) {
			let formulas = 0
			let totalSvgBytes = 0
			const compile = async (formula: unknown, display: boolean) => {
				context.signal.throwIfAborted()
				formulas += 1
				if (formulas > limits.maxFormulas) {
					throw new MarkdownError(
						'FORMULA_TOO_LARGE',
						'Typst math exceeds the configured formula-count limit',
					)
				}
				const source = validateTypstMathFormula(formula, limits.maxFormulaCharacters)
				if (totalSvgBytes >= limits.maxTotalSvgBytes) {
					throw new MarkdownError('SVG_TOO_LARGE', 'Typst math SVGs exceed the total byte limit')
				}
				let svg: Uint8Array
				try {
					svg = await typst.renderSvg(
						createTypstMathSource(source, {
							display,
							foreground: MARKDOWN_FOREGROUND[context.theme],
						}),
						{
							signal: context.signal,
							maxOutputBytes: Math.min(limits.maxSvgBytes, limits.maxTotalSvgBytes - totalSvgBytes),
						},
					)
				} catch (cause) {
					context.signal.throwIfAborted()
					// Optional providers stay type-only imports. Match TypstError and its documented compile/limit codes;
					// admission, native/IO, lifecycle and unexpected failures keep their original contracts.
					if (cause instanceof Error && cause.name === 'TypstError' && 'code' in cause) {
						if (cause.code === 'LIMIT_EXCEEDED') {
							throw new MarkdownError('SVG_TOO_LARGE', 'Typst formula exceeds its byte limit', {
								cause,
							})
						}
						if (cause.code === 'COMPILE_FAILED') {
							throw new MarkdownError(
								'FORMULA_COMPILE_FAILED',
								'Typst failed to compile the math formula',
								{
									cause,
								},
							)
						}
					}
					throw cause
				}
				context.signal.throwIfAborted()
				if (svg.byteLength > limits.maxTotalSvgBytes - totalSvgBytes) {
					throw new MarkdownError('SVG_TOO_LARGE', 'Typst math SVGs exceed the total byte limit')
				}
				totalSvgBytes += svg.byteLength
				const { width, height } = svgSize(svg)
				return {
					type: 'image' as const,
					alt: 'math',
					url: await context.assets.add({ data: svg, mediaType: 'image/svg+xml' }),
					data: {
						hProperties: {
							className: 'pluxel-math-image',
							width,
							height,
							style: `width:${width}px;height:${height}px;object-fit:contain`,
						},
					},
				}
			}
			return {
				mdast: [
					{
						name: 'pluxel-typst-math',
						async inlineMath(node, visitor) {
							visitor.replaceNode(node, await compile(node.value, false))
						},
						async math(node, visitor) {
							const image = await compile(node.value, true)
							visitor.replaceNode(node, {
								type: 'paragraph',
								data: { hProperties: { className: 'pluxel-math-display' } },
								children: [image],
							})
						},
					},
				],
			}
		},
	})
}

/** Typst's viewBox is in points; HTML image dimensions are CSS pixels (96px = 72pt). */
function svgSize(svg: Uint8Array): Readonly<{ width: number; height: number }> {
	const viewBox = /^<svg\b[^>]*\bviewBox="([^"]+)"/.exec(new TextDecoder().decode(svg))?.[1]
	const values = viewBox?.trim().split(/\s+/).map(Number)
	if (
		!values ||
		values.length !== 4 ||
		values.some((value) => !Number.isFinite(value)) ||
		values[2]! <= 0 ||
		values[3]! <= 0
	) {
		throw new MarkdownError('FORMULA_COMPILE_FAILED', 'Typst math SVG has invalid dimensions')
	}
	return { width: (values[2]! * 96) / 72, height: (values[3]! * 96) / 72 }
}
