import { FontsPlugin } from '@pluxel/fonts'
import type { PluginConstructor } from '@pluxel/runtime'
import {
	BasePlugin,
	createRuntimeTestHost,
	Plugin,
	type RawPluginConfig,
	type RuntimeTestHost,
} from '@pluxel/runtime/test'
import { TakumiPlugin } from '@pluxel/takumi'
import { defineHastPlugin, defineMdastPlugin } from 'satteri'
import { describe, expect, it } from 'vitest'
import {
	MarkdownError,
	TakumiMarkdownPlugin,
	type MarkdownExtension,
	type MarkdownExtensionFeatures,
} from '../src/index.ts'

@Plugin()
class MarkdownTestConsumer extends BasePlugin {
	constructor(
		readonly markdown: TakumiMarkdownPlugin,
		readonly takumi: TakumiPlugin,
	) {
		super()
	}
}

async function startMarkdownFixture(
	host: RuntimeTestHost,
	options: Readonly<{
		markdown?: RawPluginConfig
		takumi?: RawPluginConfig
	}> = {},
): Promise<void> {
	const plugins: readonly PluginConstructor[] = [
		FontsPlugin,
		TakumiPlugin,
		TakumiMarkdownPlugin,
		MarkdownTestConsumer,
	]
	await host.commit((change) => {
		change.catalog.add(plugins)
		if (options.takumi !== undefined) change.config.seed(TakumiPlugin, options.takumi)
		if (options.markdown !== undefined) {
			change.config.seed(TakumiMarkdownPlugin, options.markdown)
		}
		change.start(plugins)
	})
}

describe('TakumiMarkdownPlugin', () => {
	it('renders GFM tables, removes raw HTML, and gives caller HAST extensions Rangi output', async () => {
		await using host = createRuntimeTestHost({ workbench: false })
		await startMarkdownFixture(host)
		const consumer = host.require(MarkdownTestConsumer)
		let sawHighlightedCode = false
		const observer: MarkdownExtension = {
			name: 'observe-rangi-output',
			create() {
				return {
					hast: [
						defineHastPlugin({
							name: 'observe-rangi-div',
							element: {
								filter: ['div'],
								visit(node) {
									const classes = node.properties.className
									sawHighlightedCode =
										sawHighlightedCode || (Array.isArray(classes) && classes.includes('shj'))
								},
							},
						}),
					],
				}
			},
		}
		const renderer = consumer.markdown.createRenderer({ extensions: [observer] })
		try {
			const result = await renderer.render({
				markdown: [
					'# Build report',
					'',
					'| Service | P95 |',
					'| :-- | --: |',
					'| API | 18 ms |',
					'',
					'```ts',
					'const answer = 42',
					'```',
					'',
					'<img src="https://example.invalid/raw-html-must-not-survive.png">',
				].join('\n'),
				width: 640,
				height: 480,
			})

			expect([...result.data.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
			expect(sawHighlightedCode).toBe(true)
		} finally {
			await renderer.close()
		}
	})

	it('runs extension factories and AST phases in declaration order after admission', async () => {
		await using host = createRuntimeTestHost({ workbench: false })
		await startMarkdownFixture(host)
		const phases: string[] = []
		const extension = (name: string): MarkdownExtension => ({
			name,
			create() {
				phases.push(`${name}:create`)
				return {
					mdast: [
						defineMdastPlugin({
							name: `${name}:mdast`,
							before() {
								phases.push(`${name}:mdast`)
							},
						}),
					],
					hast: [
						defineHastPlugin({
							name: `${name}:hast`,
							before() {
								phases.push(`${name}:hast`)
							},
						}),
					],
				}
			},
		})
		const renderer = host
			.require(MarkdownTestConsumer)
			.markdown.createRenderer({ extensions: [extension('first'), extension('second')] })
		try {
			await renderer.render({ markdown: 'A paragraph.', width: 64, height: 32 })
			expect(phases).toEqual([
				'first:create',
				'second:create',
				'first:mdast',
				'second:mdast',
				'first:hast',
				'second:hast',
			])
		} finally {
			await renderer.close()
		}
	})
	it('rejects malformed extension parser feature variants before creating a renderer', async () => {
		await using host = createRuntimeTestHost({ workbench: false })
		await startMarkdownFixture(host)
		const markdown = host.require(MarkdownTestConsumer).markdown

		expect(() =>
			markdown.createRenderer({
				extensions: [
					{
						name: 'invalid-math-options',
						requiredFeatures: {
							math: { singleDollarTextMath: 'yes' },
						} as unknown as MarkdownExtensionFeatures,
						create() {
							return null
						},
					},
				],
			}),
		).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }))
	})

	it('does not invoke an extension factory when Takumi admission is full', async () => {
		await using host = createRuntimeTestHost({ workbench: false })
		await startMarkdownFixture(host, {
			takumi: {
				maxConcurrentRenders: 1,
				maxQueuedRenders: 0,
				maxQueuedRendersPerConsumer: 0,
			},
		})
		const consumer = host.require(MarkdownTestConsumer)
		let factoryCalls = 0
		const renderer = consumer.markdown.createRenderer({
			extensions: [
				{
					name: 'must-not-run',
					create() {
						factoryCalls += 1
						return null
					},
				},
			],
		})
		const held = await consumer.takumi.reserveRender()
		try {
			await expect(
				renderer.render({ markdown: 'Never prepared.', width: 64, height: 32 }),
			).rejects.toMatchObject({ code: 'RENDER_BUSY' })
			expect(factoryCalls).toBe(0)
		} finally {
			await held.close()
			await renderer.close()
		}
	})

	it('keeps extension and generated-asset failures structured, then closes renderer handles', async () => {
		await using host = createRuntimeTestHost({ workbench: false })
		await startMarkdownFixture(host, { markdown: { maxAssets: 1 } })
		const renderer = host.require(MarkdownTestConsumer).markdown.createRenderer({
			extensions: [
				{
					name: 'two-assets',
					async create({ assets }) {
						const [first, second] = await Promise.allSettled([
							assets.add({ data: new Uint8Array([1]), mediaType: 'image/png' }),
							assets.add({ data: new Uint8Array([2]), mediaType: 'image/png' }),
						])
						if (first.status === 'rejected') throw first.reason
						if (second.status === 'rejected') throw second.reason
						return null
					},
				},
			],
		})
		await expect(
			renderer.render({ markdown: 'Asset budget.', width: 64, height: 32 }),
		).rejects.toMatchObject({ code: 'ASSET_COUNT_EXCEEDED' })
		await renderer.close()
		await expect(
			renderer.render({ markdown: 'Closed.', width: 64, height: 32 }),
		).rejects.toMatchObject({ code: 'NOT_RUNNING' })

		const failed = host.require(MarkdownTestConsumer).markdown.createRenderer({
			extensions: [
				{
					name: 'fails',
					create() {
						throw new Error('intentional extension failure')
					},
				},
			],
		})
		try {
			await expect(failed.render({ markdown: 'Failure.', width: 64, height: 32 })).rejects.toEqual(
				expect.objectContaining({
					code: 'EXTENSION_FAILED',
					message: 'Markdown extension "fails" failed',
				}),
			)
		} finally {
			await failed.close()
		}
	})

	it('rejects reserved internal asset sources without executing a conversion', async () => {
		await using host = createRuntimeTestHost({ workbench: false })
		await startMarkdownFixture(host)
		const renderer = host.require(MarkdownTestConsumer).markdown.createRenderer()
		try {
			await expect(
				renderer.render({
					markdown: 'No collision.',
					width: 64,
					height: 32,
					images: [
						{
							src: 'pluxel://markdown-internal/caller-owned.png',
							data: new Uint8Array([1]),
						},
					],
				}),
			).rejects.toBeInstanceOf(MarkdownError)
		} finally {
			await renderer.close()
		}
	})
})
