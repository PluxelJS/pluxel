import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

// Parser/serializer receiver boundary in the existing browser service; no app session is created.
const browser = await chromium.connect('ws://127.0.0.1:3000', {
	timeout: 5000,
	exposeNetwork: '<loopback>',
})
const context = await browser.newContext()
try {
	const page = await context.newPage()
	const origin = process.env.PLUXEL_TYPST_URL ?? 'http://typst.pluxel.localhost:8088'
	await page.route('**/document-clipboard-test.html', (route) =>
		route.fulfill({
			contentType: 'text/html',
			body: '<!doctype html><title>Document clipboard test</title>',
		}),
	)
	await page.goto(new URL('/document-clipboard-test.html', origin).href)
	const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
	const result = await page.evaluate(
		async ({ sdkUrl, coreUrl }) => {
			const sdk = await import(sdkUrl)
			const { generateHTML, getSchema } = await import(coreUrl)
			const config = { regions: [{ id: 'body' }], fields: [] }
			const extensions = sdk.createTypstExtensions()
			const schema = getSchema(extensions)
			const paragraph = (...content) => ({ type: 'paragraph', content })
			const text = (value) => ({ type: 'text', text: value })
			const document = {
				type: 'doc',
				content: [
					{
						type: 'figure',
						attrs: { id: 'table-one', label: '表:收入' },
						content: [
							{
								type: 'table',
								content: [
									{
										type: 'tableRow',
										content: [{ type: 'tableCell', content: [paragraph(text('42'))] }],
									},
								],
							},
							{
								type: 'figureCaption',
								content: [{ ...text('Revenue'), marks: [{ type: 'bold' }] }],
							},
						],
					},
					{
						type: 'figure',
						attrs: { id: 'image-one', label: 'fig:logo' },
						content: [
							{ type: 'image', attrs: { src: 'logo', alt: 'Logo', width: 40 } },
							{ type: 'figureCaption', content: [text('Logo')] },
						],
					},
					{ type: 'blockMath', attrs: { latex: '\\frac{a}{b}', id: 'eq-one', label: 'eq:ratio' } },
					paragraph(
						text('Inline '),
						{ type: 'inlineMath', attrs: { latex: 'x^2' } },
						text(' see '),
						{ type: 'reference', attrs: { target: 'table-one' } },
					),
				],
			}
			const html = generateHTML(document, extensions)
			const parsed = sdk.parseTypstClipboard({ html, text: '', regionId: 'body', config })
			const equal = parsed.ok && schema.nodeFromJSON(parsed.value).eq(schema.nodeFromJSON(document))
			const invalid = [
				'<div>Unknown wrapper</div>',
				'<span data-type="other" data-latex="x"></span>',
				'<div data-type="block-math">missing source</div>',
				'<span data-type="inline-math" data-latex="x">Lost text</span>',
				'<span data-typst-reference="table-one">Lost text</span>',
				'<span data-typst-reference="">@</span>',
				'<figure id="x" label="fig:x"><p>Wrong body</p><figcaption>Caption</figcaption></figure>',
				'<figcaption>Orphan caption</figcaption>',
			].map((invalidHtml) => ({
				html: invalidHtml,
				result: sdk.parseTypstClipboard({ html: invalidHtml, text: '', regionId: 'body', config }),
			}))
			return { html, parsed, equal, invalid }
		},
		{
			sdkUrl: `/@fs${root}/src/tiptap/index.ts`,
			coreUrl: `/@fs${root}/node_modules/@tiptap/core/dist/index.js`,
		},
	)
	assert.equal(result.equal, true, JSON.stringify(result))
	for (const rejected of result.invalid)
		assert.equal(rejected.result.ok, false, JSON.stringify(rejected))
	console.log(JSON.stringify({ roundTrip: true, rejections: result.invalid.length }))
} finally {
	await context.close()
	await browser.close()
}
