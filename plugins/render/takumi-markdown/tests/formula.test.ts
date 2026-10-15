import { describe, expect, it } from 'vitest'
import { markdownToHtml } from 'satteri'
import * as v from 'valibot'
import { TakumiMarkdownConfig, createMarkdownRenderLimits } from '../src/config.ts'
import { MarkdownError } from '../src/errors.ts'
import { createTypstMathSource, validateTypstMathFormula } from '../src/formula.ts'
import { createTypstMathExtension } from '../src/math.ts'

describe('restricted Typst math formula', () => {
	it('accepts ordinary math but rejects document execution and resource syntax before compiling', () => {
		expect(validateTypstMathFormula('x^2 + y_1 = sqrt(4)', 128)).toBe('x^2 + y_1 = sqrt(4)')
		for (const source of [
			'#let danger = 1',
			'import "package.typ"',
			'include "other.typ"',
			'read("secret")',
			'image("remote.png")',
			'raw("script")',
			'\\sqrt(x)',
			'"string literal"',
		]) {
			expect(() => validateTypstMathFormula(source, 128)).toThrow(
				expect.objectContaining({ code: 'FORMULA_INVALID' }),
			)
		}
		expect(() => validateTypstMathFormula('x'.repeat(129), 128)).toThrow(
			expect.objectContaining({ code: 'FORMULA_TOO_LARGE' }),
		)
	})

	it('builds a fixed-wrapper source for the shared Typst provider', () => {
		expect(
			createTypstMathSource(' x^2 + y^2 = z^2 ', { display: false, foreground: '#172033' }),
		).toBe(
			'#set page(width: auto, height: auto, margin: 0pt, fill: none)\n' +
				'#set text(size: 12pt, fill: rgb("#172033"), top-edge: "bounds", bottom-edge: "bounds")\n' +
				'$x^2 + y^2 = z^2$',
		)
		expect(createTypstMathSource('x^2', { display: true, foreground: '#e5e7eb' })).toContain(
			'$ x^2 $',
		)
	})

	it('keeps compiler failures represented by the stable math error type', () => {
		expect(() => validateTypstMathFormula('', 128)).toThrow(MarkdownError)
	})

	it.each(['LIMIT_EXCEEDED', 'COMPILE_FAILED'])(
		'preserves unknown provider failures with the %s code',
		async (code) => {
			const config = v.parse(TakumiMarkdownConfig, {})
			const cause = Object.assign(new Error('Unknown SDK failure'), { code })
			const extension = createTypstMathExtension(
				{
					renderSvg: async () => {
						throw cause
					},
				},
				config.math,
			)
			const pipeline = await extension.create({
				source: '$x$',
				theme: 'light',
				signal: new AbortController().signal,
				limits: createMarkdownRenderLimits(config),
				assets: {
					add: async () => {
						throw new Error('Failed formulas cannot emit an asset')
					},
				},
			})
			await expect(
				markdownToHtml('$x$', {
					features: { math: true },
					mdastPlugins: [...(pipeline?.mdast ?? [])],
				}),
			).rejects.toBe(cause)
		},
	)

	it('forwards a render cancellation into an in-flight formula request and preserves its reason', async () => {
		const controller = new AbortController()
		const config = v.parse(TakumiMarkdownConfig, {})
		let entered!: () => void
		const started = new Promise<void>((resolve) => {
			entered = resolve
		})
		const extension = createTypstMathExtension(
			{
				renderSvg: (_source, options) => {
					entered()
					return new Promise<Uint8Array>((_, reject) => {
						if (!options?.signal) {
							reject(new Error('Expected a formula cancellation signal'))
							return
						}
						const signal = options.signal
						signal.addEventListener('abort', () => reject(signal.reason), { once: true })
					})
				},
			},
			config.math,
		)
		const pipeline = await extension.create({
			source: '$x$',
			theme: 'light',
			signal: controller.signal,
			limits: createMarkdownRenderLimits(config),
			assets: {
				add: async () => {
					throw new Error('Cancelled formulas cannot emit an asset')
				},
			},
		})
		const pending = markdownToHtml('$x$', {
			features: { math: true },
			mdastPlugins: [...(pipeline?.mdast ?? [])],
		})
		const rejected = Promise.resolve(pending).catch((cause: unknown) => cause)
		await started
		const reason = new Error('Request cancelled')
		controller.abort(reason)
		expect(await rejected).toBe(reason)
	})
})
