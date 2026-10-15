import { BasePlugin, Plugin } from '@pluxel/core'
import { FontsPlugin } from '@pluxel/fonts'
import { nodeModules } from '@pluxel/services/node'
import { workers } from '@pluxel/services/workers'
import { TakumiPlugin } from '@pluxel/takumi'
import { createTestHost, type RawPluginConfig } from '@pluxel/test'
import { TypstPlugin } from '@pluxel/typst'
import { defineHastPlugin } from 'satteri'
import { describe, expect, it } from 'vitest'
import { TakumiMarkdownPlugin } from '../src/index.ts'
import { renderFormulaDocument } from './fixtures/formula-consumer.ts'

@Plugin()
class Consumer extends BasePlugin {
	constructor(readonly markdown: TakumiMarkdownPlugin) {
		super()
	}
}

async function fixture(options: { typst?: boolean; config?: RawPluginConfig } = {}) {
	const host = await createTestHost({ services: [nodeModules(), workers()] })
	await host.commit((change) => {
		change.catalog.add([TakumiPlugin, TakumiMarkdownPlugin, Consumer])
		if (options.config) change.config.seed(TakumiMarkdownPlugin, options.config)
		if (options.typst) {
			change.catalog.add([FontsPlugin, TypstPlugin])
			change.start(TypstPlugin)
		}
		change.start(Consumer)
	})
	return host
}

describe('optional Typst math in Markdown', () => {
	it('keeps ordinary Markdown when Typst is unavailable, then enables math and withdraws it with its provider', async () => {
		await using host = await fixture()
		const plain = host.require(Consumer).markdown.createRenderer()
		const source = '$#let unsafe = 1$'
		const output = await plain.render(source, { width: 96, height: 48 })
		expect(output.byteLength).toBeGreaterThan(0)
		await host.commit((change) => change.catalog.add([FontsPlugin, TypstPlugin]))
		const notStarted = await plain.render(source, { width: 96, height: 48 })
		expect(notStarted.byteLength).toBeGreaterThan(0)
		await host.commit((change) => change.start(TypstPlugin))
		expect(() => plain.render('Old renderer')).toThrow('Plugin owner stopped')
		const withMath = host.require(Consumer).markdown.createRenderer()
		await expect(withMath.render(source)).rejects.toMatchObject({
			name: 'MarkdownError',
			code: 'FORMULA_INVALID',
		})
		const compiled = await withMath.render('$x^2$', { width: 96, height: 48 })
		expect(compiled.byteLength).toBeGreaterThan(0)
		await host.commit((change) => change.stop(TypstPlugin))
		expect(() => withMath.render('$x$')).toThrow('Plugin owner stopped')
		await using restored = host.require(Consumer).markdown.createRenderer()
		const restoredOutput = await restored.render(source, { width: 96, height: 48 })
		expect(restoredOutput.byteLength).toBeGreaterThan(0)
	})

	it('uses the same default renderer for inline/display math and trusted extensions', async () => {
		await using host = await fixture({ typst: true })
		let generatedImages = 0
		await using renderer = host.require(Consumer).markdown.createRenderer({
			extensions: [
				{
					name: 'observe-math',
					create: () => ({
						hast: [
							defineHastPlugin({
								name: 'observe-math',
								element: {
									filter: ['img'],
									visit(node) {
										if (String(node.properties.src).startsWith('pluxel://markdown-internal/')) {
											generatedImages += 1
										}
									},
								},
							}),
						],
					}),
				},
			],
		})
		const result = await renderFormulaDocument(
			renderer,
			'Inline $x^2 + y^2 = z^2$\n\n$$\nsum_(i=1)^n i\n$$',
			{ width: 640, height: 320 },
		)
		expect(result.isOk()).toBe(true)
		if (result.isErr()) throw new Error('Expected rendered formula document')
		expect([...result.value.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
		expect(generatedImages).toBe(2)
		const rejected = await renderFormulaDocument(renderer, '$#let unsafe = 1$')
		expect(rejected.isErr()).toBe(true)
		if (rejected.isOk()) throw new Error('Expected invalid formula')
		expect(rejected.error.reason).toBe('invalid_formula')
		await expect(renderer.render('$sqrt($')).rejects.toMatchObject({
			name: 'MarkdownError',
			code: 'FORMULA_COMPILE_FAILED',
			cause: expect.objectContaining({ code: 'COMPILE_FAILED' }),
		})
		const recovered = await renderer.render('$x^2$', { width: 96, height: 48 })
		expect(recovered.byteLength).toBeGreaterThan(0)
	})

	it.each(['light', 'dark'] as const)(
		'keeps transparent, legible inline fractions and complete display math in the %s theme',
		async (theme) => {
			await using host = await fixture({ typst: true })
			const dimensions: { width: number; height: number }[] = []
			let resolvedTheme: string | undefined
			await using renderer = host.require(Consumer).markdown.createRenderer({
				theme: 'dark',
				extensions: [
					{
						name: 'observe-formula-geometry',
						create(context) {
							resolvedTheme = context.theme
							return {
								hast: [
									defineHastPlugin({
										name: 'observe-formula-geometry',
										element: {
											filter: ['img'],
											visit(node) {
												dimensions.push({
													width: Number(node.properties.width),
													height: Number(node.properties.height),
												})
											},
										},
									}),
								],
							}
						},
					},
				],
			})
			const width = 320
			const height = 160
			const output = await renderer.render('$(a+b)/(c+d)$\n\n$$\nsum_(i=1)^n i = (n(n+1))/2\n$$', {
				theme,
				width,
				height,
				format: 'raw',
				css: '.pluxel-markdown{padding:16px}.pluxel-markdown p{margin:0}.pluxel-markdown .pluxel-math-display{margin-top:16px}',
			})
			expect(resolvedTheme).toBe(theme)
			expect(dimensions).toHaveLength(2)
			expect(dimensions[0]!.height).toBeGreaterThan(16)
			expect(dimensions[1]!.height).toBeGreaterThan(35)
			expect(
				dimensions.every(
					({ width: imageWidth, height: imageHeight }) =>
						Number.isFinite(imageWidth) &&
						imageWidth > 0 &&
						Number.isFinite(imageHeight) &&
						imageHeight > 0,
				),
			).toBe(true)
			expect(output.byteLength).toBe(width * height * 4)
			const foreground = theme === 'dark' ? [229, 231, 235] : [23, 32, 51]
			const background = theme === 'dark' ? [17, 24, 39] : [255, 255, 255]
			const rows = new Set<number>()
			let foregroundPixels = 0
			let whitePixels = 0
			for (let y = 0; y < height; y += 1) {
				for (let x = 0; x < width; x += 1) {
					const offset = (y * width + x) * 4
					if (background.some((channel, index) => Math.abs(channel - output[offset + index]!) > 20))
						rows.add(y)
					if (foreground.every((channel, index) => Math.abs(channel - output[offset + index]!) < 5))
						foregroundPixels += 1
					if (output[offset]! > 250 && output[offset + 1]! > 250 && output[offset + 2]! > 250)
						whitePixels += 1
				}
			}
			const inlineRows = [...rows].filter((y) => y < 48)
			const displayRows = [...rows].filter((y) => y >= 48)
			expect(foregroundPixels).toBeGreaterThan(20)
			expect(Math.max(...inlineRows) - Math.min(...inlineRows)).toBeGreaterThanOrEqual(16)
			expect(Math.max(...displayRows) - Math.min(...displayRows)).toBeGreaterThanOrEqual(34)
			expect(whitePixels > 0).toBe(theme === 'light')
		},
	)

	it.each([
		{ config: { maxFormulaCharacters: 1 }, source: '$xx$', code: 'FORMULA_TOO_LARGE' },
		{ config: { maxFormulas: 1 }, source: '$x$ $y$', code: 'FORMULA_TOO_LARGE' },
		{ config: { maxSvgBytes: 1 }, source: '$x$', code: 'SVG_TOO_LARGE' },
		{ config: { maxTotalSvgBytes: 1 }, source: '$x$', code: 'SVG_TOO_LARGE' },
	])('enforces math budget $config', async ({ config, source, code }) => {
		await using host = await fixture({ typst: true, config: { math: config } })
		await using renderer = host.require(Consumer).markdown.createRenderer()
		await expect(renderer.render(source, { width: 96, height: 48 })).rejects.toMatchObject({
			name: 'MarkdownError',
			code,
		})
	})

	it('aborts pending work and retires the previous renderer before provider withdrawal completes', async () => {
		await using host = await fixture({ typst: true })
		let entered!: () => void
		const started = new Promise<void>((resolve) => {
			entered = resolve
		})
		let aborted = false
		const renderer = host.require(Consumer).markdown.createRenderer({
			extensions: [
				{
					name: 'pending-extension',
					async create({ signal }) {
						entered()
						await new Promise<void>((_, reject) => {
							signal.addEventListener(
								'abort',
								() => {
									aborted = true
									reject(signal.reason)
								},
								{ once: true },
							)
						})
						return null
					},
				},
			],
		})
		const pending = renderer.render('$x$').catch((cause: unknown) => cause)
		await started
		await host.commit((change) => change.stop(TypstPlugin))
		expect(aborted).toBe(true)
		expect(await pending).toMatchObject({ code: 'NOT_RUNNING' })
		expect(() => renderer.render('$x$')).toThrow('Plugin owner stopped')
	})
})
