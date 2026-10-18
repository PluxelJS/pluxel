import { BasePlugin, Plugin } from '@pluxel/core'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { nodeModules } from '@pluxel/services/node'
import { workers } from '@pluxel/services/workers'
import { createTestHost, type RawPluginConfig } from '@pluxel/test'
import { TakumiPlugin } from '@pluxel/plugin-takumi'
import { defineHastPlugin, defineMdastPlugin } from 'satteri'
import { describe, expect, it } from 'vitest'
import {
	TakumiMarkdownPlugin,
	type MarkdownExtension,
	type MarkdownExtensionFeatures,
} from '../src/index.ts'
import { renderDocument } from './fixtures/result-consumer.ts'

@Plugin()
class Consumer extends BasePlugin {
	constructor(readonly markdown: TakumiMarkdownPlugin) {
		super()
	}
}

async function fixture(config?: RawPluginConfig) {
	const host = await createTestHost({ services: [nodeModules(), workers()] })
	await host.commit((change) => {
		change.catalog.add([TakumiPlugin, TakumiMarkdownPlugin, Consumer])
		if (config) change.config.seed(TakumiMarkdownPlugin, config)
		change.start(Consumer)
	})
	return host
}

describe('Markdown native rendering', () => {
	it('demonstrates recoverable source limits and propagates unknown extension exceptions', async () => {
		await using host = await fixture({ maxSourceBytes: 32 })
		const markdown = host.require(Consumer).markdown
		await using renderer = markdown.createRenderer()
		const rendered = await renderDocument(renderer, '# Hi', { width: 64, height: 32 })
		expect(rendered.isOk()).toBe(true)
		const oversized = await renderDocument(renderer, 'x'.repeat(33), { width: 64, height: 32 })
		expect(oversized.isErr()).toBe(true)
		if (oversized.isOk()) throw new Error('Expected oversized input to fail')
		expect(oversized.error._tag).toBe('DocumentTooLarge')
		await renderer.close()
		await expect(renderer.render('Closed')).rejects.toMatchObject({ code: 'NOT_RUNNING' })
		const defect = new Error('extension defect')
		await using broken = markdown.createRenderer({
			extensions: [
				{
					name: 'broken',
					create() {
						throw defect
					},
				},
			],
		})
		await expect(renderDocument(broken, 'Hi')).rejects.toBe(defect)
	})

	it('renders GFM and highlighted code, removes raw HTML, and forwards native CSS and formats', async () => {
		await using host = await fixture()
		let highlighted = false
		await using renderer = host.require(Consumer).markdown.createRenderer({
			extensions: [
				{
					name: 'observe',
					create: () => ({
						hast: [
							defineHastPlugin({
								name: 'observe-code',
								element: {
									filter: ['div'],
									visit(node) {
										const classes = node.properties.className
										highlighted ||= Array.isArray(classes) && classes.includes('shj')
									},
								},
							}),
						],
					}),
				},
			],
		})
		const source =
			'# Report\n\n| Name | Value |\n| -- | -- |\n| API | 42 |\n\n```ts\nconst answer = 42\n```\n\n<img src="https://example.invalid/raw.png">'
		const png = await renderer.render(source, { width: 640, height: 480 })
		expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
		expect(highlighted).toBe(true)
		const jpeg = await renderer.render('Report', {
			width: 64,
			height: 32,
			format: 'jpeg',
			quality: 80,
		})
		expect([...jpeg.subarray(0, 3)]).toEqual([255, 216, 255])
		const svg = await renderer.renderSvg(' ', {
			width: 64,
			height: 32,
			css: '.pluxel-markdown { background: red; }',
		})
		expect(svg).toContain('<svg')
		expect(svg).not.toBe(await renderer.renderSvg(' ', { width: 64, height: 32 }))
	})

	it('runs factory, MDAST and HAST phases in extension declaration order', async () => {
		await using host = await fixture()
		const phases: string[] = []
		const extension = (name: string): MarkdownExtension => ({
			name,
			create() {
				phases.push(`${name}:create`)
				return {
					mdast: [
						defineMdastPlugin({
							name,
							before() {
								phases.push(`${name}:mdast`)
							},
						}),
					],
					hast: [
						defineHastPlugin({
							name,
							before() {
								phases.push(`${name}:hast`)
							},
						}),
					],
				}
			},
		})
		await using renderer = host
			.require(Consumer)
			.markdown.createRenderer({ extensions: [extension('first'), extension('second')] })
		await renderer.render('Paragraph', { width: 64, height: 32 })
		expect(phases).toEqual([
			'first:create',
			'second:create',
			'first:mdast',
			'second:mdast',
			'first:hast',
			'second:hast',
		])
	})

	it('validates parser feature options before creating a renderer', async () => {
		await using host = await fixture()
		expect(() =>
			host.require(Consumer).markdown.createRenderer({
				extensions: [
					{
						name: 'invalid',
						requiredFeatures: {
							math: { singleDollarTextMath: 'yes' },
						} as unknown as MarkdownExtensionFeatures,
						create: () => null,
					},
				],
			}),
		).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }))
	})

	it('embeds generated assets alongside native image sources without fetching Markdown URLs', async () => {
		await using host = await fixture()
		const asset = Buffer.from(
			'<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>',
		)
		let fetches = 0
		await using server = createServer((_, response) => {
			fetches += 1
			response.writeHead(200, { 'content-type': 'image/svg+xml' }).end(asset)
		})
		await once(server.listen(0, '127.0.0.1'), 'listening')
		const address = server.address()
		if (!address || typeof address === 'string') throw new Error('Expected a TCP test server')
		const remote = `http://127.0.0.1:${address.port}/image.svg`
		await using renderer = host.require(Consumer).markdown.createRenderer({
			extensions: [
				{
					name: 'image',
					async create({ assets }) {
						const src = await assets.add({ data: asset, mediaType: 'image/svg+xml' })
						return {
							mdast: [
								defineMdastPlugin({
									name: 'image',
									paragraph(node, visitor) {
										visitor.replaceNode(node, {
											type: 'paragraph',
											children: [{ type: 'image', url: src, alt: 'generated' }],
										})
									},
								}),
							],
						}
					},
				},
			],
		})
		const png = await renderer.render('Generated', {
			width: 64,
			height: 64,
			images: {
				sources: [{ src: 'caller.svg', data: asset }],
			},
		})
		expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
		await using plain = host.require(Consumer).markdown.createRenderer()
		for (const policy of [{}, { allowRemote: undefined }, { allowRemote: false }]) {
			await expect(
				plain.render(`![remote](${remote})`, {
					width: 64,
					height: 64,
					images: policy,
				}),
			).rejects.toBeInstanceOf(Error)
		}
		expect(fetches).toBe(0)
		const allowed = await plain.render(`![remote](${remote})`, {
			width: 64,
			height: 64,
			images: { allowRemote: true },
		})
		expect([...allowed.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
		expect(fetches).toBe(1)
	})

	it('keeps generated asset counts bounded and rejects reserved caller sources', async () => {
		await using host = await fixture({ maxAssets: 1 })
		await using renderer = host.require(Consumer).markdown.createRenderer({
			extensions: [
				{
					name: 'assets',
					async create({ assets }) {
						await assets.add({ data: new Uint8Array([1]), mediaType: 'image/png' })
						await assets.add({ data: new Uint8Array([2]), mediaType: 'image/png' })
						return null
					},
				},
			],
		})
		await expect(renderer.render('Too many')).rejects.toMatchObject({
			code: 'ASSET_COUNT_EXCEEDED',
		})
		await using plain = host.require(Consumer).markdown.createRenderer()
		await expect(
			plain.render('Collision', {
				images: [{ src: 'pluxel://markdown-internal/caller.png', data: new Uint8Array([1]) }],
			}),
		).rejects.toMatchObject({ code: 'INTERNAL_ASSET_COLLISION' })
	})

	it('accounts for the captured asset when its caller reuses an input holder during copying', async () => {
		const mib = 1024 * 1024
		await using host = await fixture({ maxAssetBytes: 3 * mib, maxTotalAssetBytes: 3 * mib })
		await using renderer = host.require(Consumer).markdown.createRenderer({
			extensions: [
				{
					name: 'reuse-holder',
					async create({ assets }) {
						const holder = { data: new Uint8Array(2 * mib), mediaType: 'image/png' as const }
						const copying = assets.add(holder)
						holder.data = new Uint8Array(4 * mib)
						await copying
						await assets.add({ data: new Uint8Array(2 * mib), mediaType: 'image/png' })
						return null
					},
				},
			],
		})
		await expect(renderer.render('Assets')).rejects.toMatchObject({ code: 'ASSET_BYTES_EXCEEDED' })
	})

	it('aborts active preparation when its caller stops and rejects retained handles', async () => {
		await using host = await fixture()
		let entered!: () => void
		const started = new Promise<void>((resolve) => {
			entered = resolve
		})
		const renderer = host.require(Consumer).markdown.createRenderer({
			extensions: [
				{
					name: 'wait',
					async create({ signal }) {
						entered()
						await new Promise<void>((_, reject) => {
							signal.addEventListener('abort', () => reject(signal.reason), { once: true })
						})
						return null
					},
				},
			],
		})
		const pending = renderer.render('Waiting')
		const rejected = pending.catch((error: unknown) => error)
		await started
		await host.commit((change) => change.stop(Consumer))
		expect(await rejected).toMatchObject({ code: 'NOT_RUNNING' })
		expect(() => renderer.render('Closed')).toThrow('Plugin owner stopped')
	})
})
