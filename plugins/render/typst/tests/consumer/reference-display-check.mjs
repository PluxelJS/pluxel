import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { trackConsumerSessions } from './browser-session.mjs'

// Exercise the real consumer and compiler through the user's existing browser service.
const output = await mkdtemp(join(tmpdir(), 'typst-reference-display-'))
const browser = await chromium.connect(
	process.env.PLAYWRIGHT_WS_ENDPOINT ?? 'ws://127.0.0.1:3000',
	{ timeout: 5000, exposeNetwork: '<loopback>' },
)
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
const page = await context.newPage()
const release = trackConsumerSessions(page)
const errors = []
const checks = []
page.on('pageerror', (error) => errors.push(String(error)))
const bodyPanel = page.getByTestId('region-body')
const notesPanel = page.getByTestId('region-notes')
const body = bodyPanel.locator('.tiptap')
const notes = notesPanel.locator('.tiptap')
const doc = (element) => element.editor.getJSON()
const button = (name) => page.getByRole('button', { name, exact: true })
const tab = (name) => page.getByRole('tab', { name, exact: true }).click()
const region = (name) =>
	page
		.getByRole('navigation', { name: '正文区域', exact: true })
		.getByRole('button', { name, exact: true })
		.click()
const references = (document) =>
	document.content.flatMap((node) => node.content ?? []).filter((node) => node.type === 'reference')
async function current() {
	await page
		.getByTestId('revision')
		.filter({ hasText: / · 当前$/ })
		.or(page.getByRole('alert'))
		.first()
		.waitFor({ timeout: 60000 })
	assert.deepEqual(await page.getByRole('alert').allTextContents(), [])
}
async function display(label, value) {
	await notes.getByRole('button', { name: `引用 ${label}`, exact: true }).click()
	const select = notes.getByRole('combobox', { name: '引用显示形式', exact: true })
	await select.selectOption(value)
	await current()
	await notes.getByRole('button', { name: `引用 ${label}`, exact: true }).click()
	assert.equal(await select.inputValue(), value)
}
async function undo(panel) {
	await panel.getByRole('button', { name: '撤销', exact: true }).click()
	await current()
}
async function bounded() {
	assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
}
async function settled() {
	await page.evaluate(
		() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
	)
}
async function jump(link, position) {
	await page.locator('.preview-scroll').evaluate((element) => {
		element.scrollTop = element.scrollHeight
	})
	await link.scrollIntoViewIfNeeded()
	await settled()
	const before = {
		navigation: await page.getByTestId('navigation').textContent(),
		selection: await notes.evaluate((element) => element.editor.state.selection.toJSON()),
		href: page.url(),
	}
	const destination = await link.evaluate((element) => ({
		page: Number(element.getAttribute('data-typst-link-page')),
		x: Number(element.getAttribute('data-typst-link-x')),
		y: Number(element.getAttribute('data-typst-link-y')),
	}))
	await link.click(position ? { position } : {})
	await page.waitForFunction(
		(expected) => document.querySelector('[data-testid="page"]').textContent === `${expected} / 2`,
		destination.page,
	)
	await settled()
	const point = await page.evaluate((target) => {
		const svg = document.querySelectorAll('.typst-pages .typst-page')[target.page - 1]
		const screen = new DOMPoint(target.x, target.y).matrixTransform(svg.getScreenCTM())
		const viewport = document.querySelector('.preview-scroll').getBoundingClientRect()
		return {
			x: screen.x,
			y: screen.y,
			left: viewport.left,
			right: viewport.right,
			top: viewport.top,
			bottom: viewport.bottom,
		}
	}, destination)
	assert.ok(point.x >= point.left - 1 && point.x <= point.right + 1, JSON.stringify(point))
	assert.ok(point.y >= point.top - 1 && point.y <= point.bottom + 1, JSON.stringify(point))
	assert.deepEqual(
		{
			navigation: await page.getByTestId('navigation').textContent(),
			selection: await notes.evaluate((element) => element.editor.state.selection.toJSON()),
			href: page.url(),
		},
		before,
	)
}
try {
	const url = new URL(process.env.PLUXEL_TYPST_URL ?? 'http://typst.pluxel.localhost:8088')
	url.searchParams.set('example', 'operations-report')
	await page.goto(url.href)
	await body.locator('[data-figure-id="channels-figure"]').waitFor()
	await current()
	await region('后续行动')
	// Keep the fixture independent of additional reference examples in the report.
	await notes.evaluate((element) =>
		element.editor.commands.setContent({
			type: 'doc',
			content: [
				{
					type: 'paragraph',
					content: [{ type: 'text', text: '请核对收入、观察与达成率的引用显示。' }],
				},
				...['channels-figure', 'observations-table', 'attainment-equation'].map((target) => ({
					type: 'paragraph',
					content: [
						{ type: 'text', text: '参见 ' },
						{ type: 'reference', attrs: { target, showCaption: null } },
					],
				})),
			],
		}),
	)
	await current()
	const original = await notes.evaluate(doc)
	assert.deepEqual(
		references(original).map((node) => node.attrs.showCaption),
		[null, null, null],
	)
	const trigger = notes.getByRole('button', {
		name: '引用 fig:channels',
		exact: true,
		includeHidden: true,
	})
	await display('fig:channels', 'caption')
	assert.equal(references(await notes.evaluate(doc))[0].attrs.showCaption, true)
	assert.match(await trigger.textContent(), /@fig:channels「各渠道收入及目标对比」/)
	await undo(notesPanel)
	assert.deepEqual(await notes.evaluate(doc), original)
	await display('fig:channels', 'number')
	assert.equal(references(await notes.evaluate(doc))[0].attrs.showCaption, false)
	assert.equal(await trigger.textContent(), '@fig:channels')
	await undo(notesPanel)
	assert.deepEqual(await notes.evaluate(doc), original)
	await display('fig:channels', 'caption')
	const captionDocument = await notes.evaluate(doc)
	await display('fig:channels', 'template')
	assert.equal(references(await notes.evaluate(doc))[0].attrs.showCaption, null)
	assert.equal(await trigger.textContent(), '@fig:channels')
	await undo(notesPanel)
	assert.deepEqual(await notes.evaluate(doc), captionDocument)
	checks.push('three display choices and independent native undo')

	// A reference displays the current caption from the other region, never a copied snapshot.
	await region('经营解读')
	const originalBody = await body.evaluate(doc)
	await body.evaluate((element) => {
		const editor = element.editor
		let selection
		editor.state.doc.descendants((node, position) => {
			if (node.attrs.id !== 'channels-figure') return
			const caption = node.lastChild
			const from = position + 2 + node.firstChild.nodeSize
			selection = { from, to: from + caption.content.size }
		})
		editor.chain().focus().setTextSelection(selection).run()
	})
	await page.keyboard.insertText('按渠道核对收入与目标')
	await current()
	assert.match(await trigger.textContent(), /「按渠道核对收入与目标」/)
	await undo(bodyPanel)
	assert.deepEqual(await body.evaluate(doc), originalBody)
	assert.match(await trigger.textContent(), /「各渠道收入及目标对比」/)
	checks.push('cross-region caption changes and undo update the reference')

	// Agent Markdown retains explicit true, explicit false, and the template default separately.
	await region('后续行动')
	await display('tbl:observations', 'number')
	const mixed = await notes.evaluate(doc)
	assert.deepEqual(
		references(mixed).map((node) => node.attrs.showCaption),
		[true, false, null],
	)
	await tab('Markdown')
	await page.getByRole('combobox', { name: '候选修改范围', exact: true }).selectOption('region')
	const live = page.getByRole('textbox', { name: '实时 Markdown', exact: true })
	const markdown = await live.inputValue()
	const markers = [...markdown.matchAll(/\[ref (\{[^\n]*?\})\]/g)].map((match) =>
		JSON.parse(match[1]),
	)
	assert.equal(markers.find((attrs) => attrs.target === 'channels-figure').showCaption, true)
	assert.equal(markers.find((attrs) => attrs.target === 'observations-table').showCaption, false)
	assert.equal(
		markers.find((attrs) => attrs.target === 'attainment-equation').showCaption ?? null,
		null,
	)
	await button('编辑这份 Markdown').click()
	const candidate = page.getByRole('textbox', { name: '候选 Markdown', exact: true })
	await candidate.fill(`${markdown}\n\n引用显示往返核对。`)
	await button('查看修改预览').click()
	await button('接纳候选').click()
	await live.waitFor()
	await current()
	const roundtrip = await notes.evaluate(doc)
	assert.deepEqual(roundtrip.content.slice(0, -1), mixed.content)
	assert.equal(roundtrip.content.at(-1).content[0].text, '引用显示往返核对。')
	await undo(notesPanel)
	assert.deepEqual(await notes.evaluate(doc), mixed)
	checks.push('agent Markdown preserves all three states without changing surrounding content')

	// The human @ completion route inherits the template unless the user chooses an override.
	await tab('Typst 预览')
	await notes.evaluate((element) =>
		element.editor
			.chain()
			.insertContentAt(element.editor.state.doc.content.size, { type: 'paragraph' })
			.focus('end')
			.run(),
	)
	await notes.focus()
	await page.keyboard.type('@fig:ch')
	const suggestions = page.getByRole('listbox', { name: '引用图、表或公式' })
	await suggestions.getByRole('option').filter({ hasText: 'fig:channels' }).waitFor()
	await page.keyboard.press('Enter')
	await current()
	const inserted = references(await notes.evaluate(doc)).at(-1)
	assert.equal(inserted.attrs.target, 'channels-figure')
	assert.equal(inserted.attrs.showCaption, null)
	await notes.evaluate((element, content) => element.editor.commands.setContent(content), mixed)
	await current()
	checks.push('@ completion inserts a reference that follows the template')

	await trigger.click()
	await bounded()
	await page.screenshot({ path: join(output, 'desktop-editor.png'), fullPage: true })
	await page.setViewportSize({ width: 390, height: 844 })
	await trigger.scrollIntoViewIfNeeded()
	await bounded()
	await page.screenshot({ path: join(output, 'mobile-editor.png'), fullPage: true })
	await page.setViewportSize({ width: 1440, height: 1000 })

	// Two included regions exercise template defaults and per-reference overrides through native Typst.
	const figureCaption = '渠道收入对比'
	const tableCaption = '经营观察及核验建议'
	await body.evaluate((element, caption) => {
		const nodes = element.editor.getJSON().content
		const image = nodes.find((node) => node.type === 'image')
		image.attrs.width = 250
		image.attrs.height = 62
		element.editor.commands.setContent({
			type: 'doc',
			content: [
				{
					type: 'figure',
					attrs: { id: 'channels-figure', label: 'fig:channels' },
					content: [image, { type: 'figureCaption', content: [{ type: 'text', text: caption }] }],
				},
				nodes.find((node) => node.attrs?.id === 'observations-table'),
				nodes.find((node) => node.attrs?.id === 'attainment-equation'),
			],
		})
	}, figureCaption)
	const nativeCases = [
		['FIG-TEMPLATE', 'channels-figure', null],
		['FIG-NUMBER', 'channels-figure', false],
		['FIG-CAPTION', 'channels-figure', true],
		['TABLE-TEMPLATE', 'observations-table', null],
		['TABLE-NUMBER', 'observations-table', false],
		['TABLE-CAPTION', 'observations-table', true],
		['EQUATION-CAPTION', 'attainment-equation', true],
	]
	await notes.evaluate(
		(element, values) =>
			element.editor.commands.setContent({
				type: 'doc',
				content: values.map(([title, target, showCaption]) => ({
					type: 'paragraph',
					content: [
						{ type: 'text', text: `${title}: ` },
						{ type: 'reference', attrs: { target, showCaption } },
					],
				})),
			}),
		nativeCases,
	)
	const template = page.getByRole('textbox', { name: 'Typst 源码', exact: true })
	for (const showCaption of [false, true]) {
		await tab('原始 Typst')
		await template.fill(`#import "_editor/references.typ": reference-caption
#reference-caption.update(${showCaption})
#set page(paper: "a5", margin: 24pt)
#set text(font: "Noto Serif CJK SC", size: 10pt, lang: "zh")
#set math.equation(numbering: "(1)")
#include "_editor/regions/body.typ"
#pagebreak()
#include "_editor/regions/notes.typ"`)
		await current()
		await tab('Typst 预览')
		assert.equal(await page.locator('.typst-pages .typst-page').count(), 2)
		const referencePage = page.locator('.typst-pages .typst-page').last()
		const text = await referencePage.textContent()
		await writeFile(join(output, `native-default-${showCaption}.txt`), text)
		for (let index = 0; index < nativeCases.length; index++) {
			const [title, target, explicit] = nativeCases[index]
			const after = text.split(`${title}:`)[1]
			assert.ok(after, `native preview contains ${title}: ${text}`)
			const section =
				index + 1 < nativeCases.length ? after.split(`${nativeCases[index + 1][0]}:`)[0] : after
			if (target === 'attainment-equation') {
				assert.match(section.replaceAll(/\s/g, ''), /1/)
				assert.doesNotMatch(section, /「/)
			} else {
				const caption = target === 'channels-figure' ? figureCaption : tableCaption
				assert.equal(
					section.replaceAll(/\s/g, '').includes(caption),
					explicit ?? showCaption,
					`${title} with template default ${showCaption}`,
				)
				assert.match(section.replaceAll(/\s/g, ''), target === 'channels-figure' ? /图1/ : /表1/)
			}
		}
		await referencePage.evaluate((element) => {
			const viewport = element.closest('.preview-scroll')
			viewport.scrollTop +=
				element.getBoundingClientRect().top - viewport.getBoundingClientRect().top
		})
		await settled()
		await page.screenshot({
			path: join(output, `native-default-${showCaption}.png`),
			fullPage: true,
		})
		const links = referencePage.locator('a[data-typst-link-page="1"]')
		// Native Typst emits a link for each number and an additional link for each visible caption.
		const captionCount = nativeCases.filter(
			([, target, explicit]) => target !== 'attainment-equation' && (explicit ?? showCaption),
		).length
		assert.ok((await links.count()) >= nativeCases.length + captionCount)
		for (let index = 0; index < (await links.count()); index++) await jump(links.nth(index))
		checks.push(
			`native template default ${showCaption}, explicit overrides, and all reference links navigate`,
		)
	}
	await page.setViewportSize({ width: 390, height: 844 })
	await button('预览').click()
	await page
		.locator('.typst-pages .typst-page')
		.last()
		.evaluate((element) => {
			const viewport = element.closest('.preview-scroll')
			viewport.scrollTop +=
				element.getBoundingClientRect().top - viewport.getBoundingClientRect().top
		})
	await settled()
	await bounded()
	await page.screenshot({ path: join(output, 'mobile-preview.png'), fullPage: true })
	assert.deepEqual(errors, [])
	await writeFile(join(output, 'result.json'), JSON.stringify({ checks, errors }, null, 2))
	console.log(JSON.stringify({ result: 'passed', output, checks, errors }, null, 2))
} catch (error) {
	await page.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {})
	console.error(JSON.stringify({ output, checks, errors }, null, 2))
	throw error
} finally {
	try {
		await release()
	} finally {
		await context.close()
		await browser.close()
	}
}
