import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { trackConsumerSessions } from './browser-session.mjs'

// Use the managed consumer and shared browser; never launch either here.
const baseline = process.argv.includes('--baseline')
const output = await mkdtemp(join(tmpdir(), 'typst-reference-navigation-'))
const browser = await chromium.connect(
	process.env.PLAYWRIGHT_WS_ENDPOINT ?? 'ws://127.0.0.1:3000',
	{ timeout: 5000, exposeNetwork: '<loopback>' },
)
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
const page = await context.newPage()
const release = trackConsumerSessions(page)
const errors = []
page.on('pageerror', (error) => errors.push(String(error)))
const body = page.getByTestId('region-body').locator('.tiptap')
const notes = page.getByTestId('region-notes').locator('.tiptap')
const tab = (name) => page.getByRole('tab', { name, exact: true }).click()
const source = page.getByRole('textbox', { name: 'Typst 源码', exact: true })
const scroll = page.locator('.preview-scroll')
const cases = []
const fixtureSource = `#set page(paper: "a5", margin: 24pt)
#set text(font: "Noto Serif CJK SC", size: 10pt, lang: "zh")
#set math.equation(numbering: "(1)")
#include "_editor/regions/body.typ"
#pagebreak()
#include "_editor/regions/notes.typ"`
async function current() {
	await page
		.getByTestId('revision')
		.filter({ hasText: / · 当前$/ })
		.waitFor({ timeout: 60000 })
	assert.equal(await page.getByRole('alert').count(), 0)
}
async function snapshot() {
	return {
		page: await page.getByTestId('page').textContent(),
		navigation: await page.getByTestId('navigation').textContent(),
		selection: await Promise.all(
			[body, notes].map((editor) =>
				editor.evaluate((element) => ({
					from: element.editor.state.selection.from,
					to: element.editor.state.selection.to,
				})),
			),
		),
		href: page.url(),
	}
}
async function settled() {
	await page.evaluate(
		() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
	)
}
async function referencePage() {
	await scroll.evaluate((element) => {
		element.scrollTop = element.scrollHeight
	})
	await page.waitForFunction(
		() => document.querySelector('[data-testid="page"]').textContent === '4 / 4',
	)
	await settled()
}
async function destination(link) {
	return link.evaluate((element) => ({
		page: Number(element.getAttribute('data-typst-link-page')),
		x: Number(element.getAttribute('data-typst-link-x')),
		y: Number(element.getAttribute('data-typst-link-y')),
	}))
}
async function visibleDestination(
	target,
	container = '.typst-pages',
	viewport = '.preview-scroll',
) {
	const point = await page.evaluate(
		(args) => {
			const svg = document.querySelector(args.container).querySelectorAll('.typst-page')[
				args.target.page - 1
			]
			const screen = new DOMPoint(args.target.x, args.target.y).matrixTransform(svg.getScreenCTM())
			const rect = document.querySelector(args.viewport).getBoundingClientRect()
			return {
				x: screen.x,
				y: screen.y,
				left: rect.left,
				right: rect.right,
				top: rect.top,
				bottom: rect.bottom,
			}
		},
		{ target, container, viewport },
	)
	assert.ok(point.x >= point.left - 1 && point.x <= point.right + 1, JSON.stringify(point))
	assert.ok(point.y >= point.top - 1 && point.y <= point.bottom + 1, JSON.stringify(point))
	return point
}
async function follow(targetPage, method = 'mouse') {
	await referencePage()
	const link = page.locator(`.typst-pages a[data-typst-link-page="${targetPage}"]`).first()
	const target = await destination(link)
	assert.equal(await link.getAttribute('onclick'), null)
	const before = await snapshot()
	if (method === 'keyboard') {
		await link.focus()
		await page.keyboard.press('Enter')
	} else await link.click()
	await page.waitForFunction(
		(expected) => document.querySelector('[data-testid="page"]').textContent === `${expected} / 4`,
		targetPage,
	)
	await settled()
	const after = await snapshot()
	assert.deepEqual(
		{ ...after, page: before.page },
		before,
		'preview links must not navigate to source, change editor selection, or mutate the URL',
	)
	const point = await visibleDestination(target)
	cases.push({ target, method, point, page: after.page })
}
try {
	const url = new URL(process.env.PLUXEL_TYPST_URL ?? 'http://typst.pluxel.localhost:8088')
	url.searchParams.set('example', 'operations-report')
	await page.goto(url.href)
	await body.locator('[data-figure-id="channels-figure"]').waitFor()
	await current()
	if (baseline) {
		const link = page.locator('.typst-pages a[onclick*="handleTypstLocation"]').first()
		await link.scrollIntoViewIfNeeded()
		const before = await snapshot()
		const nativeCallback = await link.getAttribute('onclick')
		const pageError = page.waitForEvent('pageerror', {
			predicate: (error) => /handleTypstLocation/.test(String(error)),
		})
		await link.click()
		await pageError
		const after = await snapshot()
		assert.equal(after.page, before.page)
		assert.ok(errors.some((error) => /handleTypstLocation is not defined/.test(error)))
		await page.screenshot({ path: join(output, 'baseline.png'), fullPage: true })
		await writeFile(
			join(output, 'baseline.json'),
			JSON.stringify({ nativeCallback, before, after, errors }, null, 2),
		)
		console.log(
			JSON.stringify(
				{ baseline: 'reproduced', output, nativeCallback, before, after, errors },
				null,
				2,
			),
		)
	} else {
		// Keep real semantic figure/table/equation nodes in body and cross-region references in notes.
		// Explicit page breaks make a wrong destination observable even when all refs have the same text.
		await body.evaluate((element) => {
			const editor = element.editor
			const content = editor.getJSON().content
			const image = content.find((node) => node.type === 'image')
			image.attrs.width = 250
			image.attrs.height = 62
			const pagebreak = (id) => ({ type: 'typstSource', attrs: { id, source: '#pagebreak()' } })
			editor.commands.setContent({
				type: 'doc',
				content: [
					{
						type: 'figure',
						attrs: { id: 'channels-figure', label: 'fig:channels' },
						content: [
							image,
							{ type: 'figureCaption', content: [{ type: 'text', text: '渠道收入对比' }] },
						],
					},
					pagebreak('figure-page-break'),
					content.find((node) => node.attrs?.id === 'observations-table'),
					pagebreak('table-page-break'),
					content.find((node) => node.attrs?.id === 'attainment-equation'),
				],
			})
		})
		await notes.evaluate((element) =>
			element.editor.commands.setContent({
				type: 'doc',
				content: ['channels-figure', 'observations-table', 'attainment-equation'].map((target) => ({
					type: 'paragraph',
					content: [
						{ type: 'text', text: '参见 ' },
						{ type: 'reference', attrs: { target } },
					],
				})),
			}),
		)
		await tab('原始 Typst')
		const compiled = page.waitForResponse(
			(response) =>
				new URL(response.url()).pathname === '/compile' &&
				response.ok() &&
				response.request().postDataJSON().source === fixtureSource,
		)
		await source.fill(fixtureSource)
		const response = await compiled
		const result = await response.json()
		const packet = result.preview
		await current()
		await tab('Typst 预览')
		assert.equal(await page.locator('.typst-pages .typst-page').count(), 4)
		assert.equal(await page.locator('.typst-pages a[data-typst-link-page]').count(), 3)
		assert.equal(await page.evaluate(() => typeof window.handleTypstLocation), 'undefined')
		for (const targetPage of [1, 2, 3]) {
			await follow(targetPage)
			await page.screenshot({ path: join(output, `target-${targetPage}.png`), fullPage: true })
		}
		await follow(1, 'keyboard')
		await page.getByRole('combobox', { name: '缩放', exact: true }).selectOption('1.5')
		await settled()
		await follow(2)
		await follow(3, 'keyboard')
		await page.screenshot({ path: join(output, 'zoomed-equation.png'), fullPage: true })

		// A modifier click and a pointer drag preserve the user's reading position.
		await referencePage()
		const link = page.locator('.typst-pages a[data-typst-link-page="1"]')
		await link.scrollIntoViewIfNeeded()
		await settled()
		const beforeIgnored = await snapshot()
		const scrollBefore = await scroll.evaluate((element) => element.scrollTop)
		await link.click({ modifiers: ['Control'] })
		const bounds = await link.boundingBox()
		await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
		await page.mouse.down()
		await page.mouse.move(bounds.x + bounds.width / 2 + 12, bounds.y + bounds.height / 2, {
			steps: 3,
		})
		await page.mouse.up()
		await settled()
		assert.deepEqual(await snapshot(), beforeIgnored)
		assert.equal(await scroll.evaluate((element) => element.scrollTop), scrollBefore)
		assert.equal(context.pages().length, 1)
		cases.push({ ignored: ['modifier', 'drag'] })

		// A failed new compilation leaves the previous drawing visible, but its links cannot navigate.
		await tab('原始 Typst')
		await source.fill('#let = invalid')
		await page
			.getByTestId('revision')
			.filter({ hasText: / · 过期$/ })
			.waitFor({ timeout: 60000 })
		await tab('Typst 预览')
		await referencePage()
		await link.scrollIntoViewIfNeeded()
		await settled()
		const staleBefore = await snapshot()
		const staleScroll = await scroll.evaluate((element) => element.scrollTop)
		await link.click()
		await link.focus()
		await page.keyboard.press('Enter')
		await settled()
		assert.deepEqual(await snapshot(), staleBefore)
		assert.equal(await scroll.evaluate((element) => element.scrollTop), staleScroll)
		cases.push({ ignored: ['stale mouse', 'stale keyboard'], nativeRevision: packet.revision })
		assert.deepEqual(errors, [])
		await writeFile(join(output, 'result.json'), JSON.stringify({ cases, errors }, null, 2))
		console.log(JSON.stringify({ result: 'passed', output, cases, errors }, null, 2))
	}
} catch (error) {
	await page.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {})
	console.error(JSON.stringify({ output, errors }, null, 2))
	throw error
} finally {
	await release()
	await context.close()
	await browser.close()
}
