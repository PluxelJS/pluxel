import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { trackConsumerSessions } from './browser-session.mjs'

// Use the existing app and shared browser service; never start either here.
const output = await mkdtemp(join(tmpdir(), 'typst-document-ui-'))
const browser = await chromium.connect(
	process.env.PLAYWRIGHT_WS_ENDPOINT ?? 'ws://127.0.0.1:3000',
	{ timeout: 5000, exposeNetwork: '<loopback>' },
)
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
const page = await context.newPage()
const release = trackConsumerSessions(page)
const errors = []
page.on('pageerror', (error) => errors.push(String(error)))
const bodyPanel = page.getByTestId('region-body')
const notesPanel = page.getByTestId('region-notes')
const body = bodyPanel.locator('.tiptap')
const notes = notesPanel.locator('.tiptap')
const doc = (element) => element.editor.getJSON()
const button = (name) => page.getByRole('button', { name, exact: true })
async function current() {
	await page
		.getByTestId('revision')
		.filter({ hasText: / · 当前$/ })
		.waitFor({ timeout: 60000 })
	assert.equal(await page.getByRole('alert').count(), 0)
}
async function bounded() {
	assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
}
try {
	const url = new URL(process.env.PLUXEL_TYPST_URL ?? 'http://typst.pluxel.localhost:8088')
	url.searchParams.set('example', 'operations-report')
	await page.goto(url.href)
	await body.locator('[data-figure-id="channels-figure"]').waitFor()
	await current()
	assert.equal(await body.locator('figcaption').count(), 2)
	assert.equal(await body.locator('.katex').count(), 2)
	const original = await body.evaluate(doc)
	await page.screenshot({ path: join(output, 'desktop.png'), fullPage: true })

	// A label is an explicit draft. Reject duplicate labels without changing document identity.
	const figure = body.locator('[data-figure-id="channels-figure"]')
	await figure.locator('.typst-object-settings > summary').click()
	const label = figure.getByRole('textbox', { name: '图引用 label', exact: true })
	await label.fill('tbl:observations')
	await figure.getByRole('button', { name: '应用 label', exact: true }).click()
	await figure.getByRole('alert').filter({ hasText: '相同 label' }).waitFor()
	assert.deepEqual(await body.evaluate(doc), original)
	await figure.getByRole('button', { name: '取消修改', exact: true }).click()
	assert.equal(await label.inputValue(), 'fig:channels')
	assert.equal(await figure.getByRole('alert').count(), 0)
	assert.equal(await label.getAttribute('data-typst-unapplied'), null)
	await label.fill('fig:cancelled')
	await label.press('Escape')
	assert.equal(await label.inputValue(), 'fig:channels')
	assert.equal(await label.getAttribute('data-typst-unapplied'), null)
	assert.deepEqual(await body.evaluate(doc), original)
	await label.fill('fig:renamed-channels')
	await figure.getByRole('button', { name: '应用 label', exact: true }).click()
	await current()
	assert.match(
		await notesPanel.locator('.typst-reference').first().textContent(),
		/fig:renamed-channels/,
	)
	await bodyPanel.getByRole('button', { name: '撤销', exact: true }).click()
	await current()
	assert.deepEqual(await body.evaluate(doc), original)

	// Native rich caption editing and the table remain live children, not nested editors.
	await body.locator('figcaption').first().fill('更新后的渠道图题')
	await current()
	const captionDocument = await body.evaluate(doc)
	assert.equal(captionDocument.content[2].content[1].content[0].text, '更新后的渠道图题')
	await bodyPanel.getByRole('button', { name: '撤销', exact: true }).click()
	await current()

	// Finish a caption and continue in the following body paragraph with native Enter.
	await body.evaluate((element) => {
		const editor = element.editor
		let end
		editor.state.doc.descendants((node, position) => {
			if (end === undefined && node.type.name === 'figureCaption')
				end = position + 1 + node.content.size
		})
		editor.chain().focus().setTextSelection(end).run()
	})
	await page.keyboard.press('Enter')
	await current()
	const afterCaption = await body.evaluate(doc)
	assert.equal(afterCaption.content.length, original.content.length + 1)
	assert.equal(afterCaption.content[3].type, 'paragraph')
	await bodyPanel.getByRole('button', { name: '撤销', exact: true }).click()
	await current()
	assert.deepEqual(await body.evaluate(doc), original)

	// One formula apply updates LaTeX and label, and one undo restores both.
	await body.getByRole('button', { name: '编辑独立公式', exact: true }).click()
	await page
		.getByRole('textbox', { name: '公式 LaTeX', exact: true })
		.filter({ visible: true })
		.fill('r = \\frac{A-T}{T}')
	await page.getByRole('textbox', { name: '公式引用 label', exact: true }).fill('eq:variance')
	await button('应用公式').filter({ visible: true }).click()
	await current()
	assert.match(await notesPanel.locator('.typst-reference').last().textContent(), /eq:variance/)
	await bodyPanel.getByRole('button', { name: '撤销', exact: true }).click()
	await current()
	assert.deepEqual(await body.evaluate(doc), original)

	// @ keyboard completion searches the other body file and inserts object identity.
	await page
		.getByRole('navigation', { name: '正文区域', exact: true })
		.getByRole('button', { name: '后续行动', exact: true })
		.click()
	await notes.evaluate((element) =>
		element.editor
			.chain()
			.insertContentAt(element.editor.state.doc.content.size, { type: 'paragraph' })
			.focus('end')
			.run(),
	)
	await notes.focus()
	await page.keyboard.type('@eq:att')
	const suggestions = page.getByRole('listbox', { name: '引用图、表或公式' })
	await suggestions.getByRole('option').filter({ hasText: 'eq:attainment' }).waitFor()
	await page.screenshot({ path: join(output, 'reference-menu.png'), fullPage: true })
	await page.keyboard.press('Enter')
	await current()
	const referencedDocument = await notes.evaluate(doc)
	assert.equal(
		referencedDocument.content
			.flatMap((node) => node.content ?? [])
			.filter((node) => node.type === 'reference' && node.attrs.target === 'attainment-equation')
			.length,
		2,
	)
	await page
		.getByRole('navigation', { name: '正文区域', exact: true })
		.getByRole('button', { name: '经营解读', exact: true })
		.click()

	// Copy via native block UI regenerates outer and nested identities; move preserves them.
	await body.evaluate((element) => {
		const e = element.editor
		let at
		e.state.doc.descendants((node, pos) => {
			if (node.attrs.id === 'channels-figure') at = pos
		})
		e.commands.setNodeSelection(at)
		e.view.focus()
	})
	await page.keyboard.press('Alt+F10')
	await page.getByRole('button', { name: '当前块操作', exact: true }).click()
	await page.getByRole('button', { name: '复制块', exact: true }).click()
	await current()
	const copiedDocument = await body.evaluate(doc)
	const copied = copiedDocument.content.filter(
		(node) => node.type === 'figure' && node.content[0].type === 'templateBlock',
	)
	assert.equal(copied.length, 2)
	assert.notEqual(copied[0].attrs.id, copied[1].attrs.id)
	assert.notEqual(copied[0].attrs.label, copied[1].attrs.label)
	assert.notEqual(copied[0].content[0].attrs.id, copied[1].content[0].attrs.id)
	await bodyPanel.getByRole('button', { name: '撤销', exact: true }).click()
	await current()

	// The native table within a figure still accepts table commands.
	await body.locator('[data-figure-id="observations-table"] td').first().click()
	await body.evaluate((element) => element.editor.commands.addRowAfter())
	await current()
	const tableDocument = await body.evaluate(doc)
	const tableFigure = tableDocument.content.find((node) => node.attrs?.id === 'observations-table')
	assert.equal(tableFigure.content[0].content.length, 4)
	assert.equal(tableFigure.content[1].type, 'figureCaption')
	await bodyPanel.getByRole('button', { name: '撤销', exact: true }).click()
	await current()

	// The existing inner chart menu copies its figure owner, including the caption.
	const chart = body.locator('[data-block-id="channels-primary"]')
	await chart.getByRole('button', { name: '块操作', exact: true }).click()
	await chart.getByRole('menuitem', { name: '复制一份', exact: true }).click()
	await current()
	const innerCopy = await body.evaluate(doc)
	const copiedCharts = innerCopy.content.filter(
		(node) => node.type === 'figure' && node.content[0].type === 'templateBlock',
	)
	assert.equal(copiedCharts.length, 2)
	assert.notEqual(copiedCharts[0].attrs.id, copiedCharts[1].attrs.id)
	assert.equal(copiedCharts[1].content[1].type, 'figureCaption')
	await bodyPanel.getByRole('button', { name: '撤销', exact: true }).click()
	await current()

	// Native cut/paste moves the chart and its caption together without breaking outside references.
	const beforeCut = await body.evaluate(doc)
	const cutResult = await body.evaluate((element) => {
		const e = element.editor
		let at
		e.state.doc.descendants((node, position) => {
			if (node.attrs.id === 'channels-figure') at = position
		})
		e.commands.setNodeSelection(at)
		const transfer = new DataTransfer()
		e.view.dom.dispatchEvent(
			new ClipboardEvent('cut', { clipboardData: transfer, bubbles: true, cancelable: true }),
		)
		const cut = e.getJSON()
		e.commands.setTextSelection(e.state.doc.content.size)
		e.view.dom.dispatchEvent(
			new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
		)
		return { cut, pasted: e.getJSON() }
	})
	assert.equal(
		cutResult.cut.content.some((node) => node.attrs?.id === 'channels-figure'),
		false,
	)
	assert.equal(
		cutResult.pasted.content.filter((node) => node.attrs?.id === 'channels-figure').length,
		1,
	)
	assert.equal(
		cutResult.pasted.content.find((node) => node.attrs?.id === 'channels-figure').content[0].attrs
			.id,
		'channels-primary',
	)
	await current()
	await body.evaluate((element) => {
		element.editor.commands.undo()
		element.editor.commands.undo()
	})
	await current()
	assert.deepEqual(await body.evaluate(doc), beforeCut)

	// Ordinary clipboard copying a table figure allocates new identities.
	const clipboardCopy = await body.evaluate((element) => {
		const e = element.editor
		let at
		e.state.doc.descendants((node, position) => {
			if (node.attrs.id === 'observations-table') at = position
		})
		e.commands.setNodeSelection(at)
		const transfer = new DataTransfer()
		e.view.dom.dispatchEvent(
			new ClipboardEvent('copy', { clipboardData: transfer, bubbles: true, cancelable: true }),
		)
		e.commands.setTextSelection(e.state.doc.content.size)
		e.view.dom.dispatchEvent(
			new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
		)
		return e.getJSON()
	})
	const copiedTables = clipboardCopy.content.filter(
		(node) => node.type === 'figure' && node.content[0].type === 'table',
	)
	assert.equal(copiedTables.length, 2)
	assert.notEqual(copiedTables[0].attrs.id, copiedTables[1].attrs.id)
	assert.notEqual(copiedTables[0].attrs.label, copiedTables[1].attrs.label)
	await current()
	await bodyPanel.getByRole('button', { name: '撤销', exact: true }).click()
	await current()

	// Agent Markdown expresses the editable caption, math and stable cross-file reference.
	await page.getByRole('tab', { name: 'Markdown', exact: true }).click()
	const markdown = page.getByRole('textbox', { name: '实时 Markdown', exact: true })
	assert.match(await markdown.inputValue(), /:::figure/)
	assert.match(await markdown.inputValue(), /:::caption/)
	assert.match(await markdown.inputValue(), /eq:attainment/)
	await page
		.getByRole('navigation', { name: '正文区域', exact: true })
		.getByRole('button', { name: '后续行动', exact: true })
		.click()
	assert.match(await markdown.inputValue(), /\[ref \{"target":"attainment-equation"\}\]/)
	await bounded()
	await page.setViewportSize({ width: 390, height: 844 })
	await bounded()
	await page.screenshot({ path: join(output, 'mobile-editor.png'), fullPage: true })
	await button('预览').click()
	await bounded()
	await page.screenshot({ path: join(output, 'mobile-markdown.png'), fullPage: true })
	assert.deepEqual(errors, [])
	await writeFile(
		join(output, 'result.json'),
		JSON.stringify({ passed: true, output, errors }, null, 2),
	)
	console.log(JSON.stringify({ passed: true, output }))
} catch (error) {
	const failureText = await page.locator('body').innerText()
	console.error(failureText.slice(-6500))
	await page.screenshot({ path: join(output, 'failure.png'), fullPage: true })
	console.error('Evidence:', output)
	throw error
} finally {
	await release()
	await context.close()
	await browser.close()
}
