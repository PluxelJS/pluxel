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
async function captionRow(object, input) {
	const caption = await object.locator('figcaption').boundingBox()
	const label = await input.boundingBox()
	assert.ok(caption && label)
	assert.ok(
		Math.max(caption.y, label.y) < Math.min(caption.y + caption.height, label.y + label.height),
		'caption and label share a visible row',
	)
	assert.ok(caption.x + caption.width <= label.x + 1, 'caption and label do not overlap')
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

	// Labels stay beside captions; invalid input remains local and can be restored.
	const figure = body.locator('[data-figure-id="channels-figure"]')
	const label = figure.getByRole('textbox', { name: '图引用 label', exact: true })
	await label.waitFor({ state: 'visible' })
	assert.equal(
		await figure.locator('.typst-object-settings, .typst-object-meta [popover]').count(),
		0,
	)
	assert.equal(await figure.getByRole('button', { name: '应用 label', exact: true }).count(), 0)
	await label.fill('tbl:observations')
	await label.press('Enter')
	await figure.getByRole('alert').filter({ hasText: '相同 label' }).waitFor()
	assert.deepEqual(await body.evaluate(doc), original)
	assert.equal(await label.getAttribute('data-typst-unapplied'), 'true')
	await figure.getByRole('button', { name: '恢复 label', exact: true }).click()
	assert.equal(await label.inputValue(), 'fig:channels')
	assert.equal(await figure.getByRole('alert').count(), 0)
	assert.equal(await label.getAttribute('data-typst-unapplied'), null)
	await label.fill('fig:cancelled')
	await label.press('Escape')
	assert.equal(await label.inputValue(), 'fig:channels')
	assert.equal(await label.getAttribute('data-typst-unapplied'), null)
	assert.deepEqual(await body.evaluate(doc), original)
	await label.fill('fig:renamed-channels')
	await label.press('Enter')
	await current()
	assert.match(
		await notesPanel.locator('.typst-reference').first().textContent(),
		/fig:renamed-channels/,
	)
	await bodyPanel.getByRole('button', { name: '撤销', exact: true }).click()
	await current()
	assert.deepEqual(await body.evaluate(doc), original)

	// A field changed elsewhere cannot be overwritten by an older local draft.
	await label.fill('fig:local-draft')
	await body.evaluate((element) => {
		const editor = element.editor
		let at
		editor.state.doc.descendants((node, position) => {
			if (node.attrs.id === 'channels-figure') at = position
		})
		editor
			.chain()
			.setNodeSelection(at)
			.updateAttributes('figure', { label: 'fig:external-change' })
			.run()
	})
	await figure.getByRole('alert').filter({ hasText: '其他位置修改' }).waitFor()
	assert.equal(await label.inputValue(), 'fig:local-draft')
	await label.press('Enter')
	const externallyChanged = await body.evaluate(doc)
	assert.equal(
		externallyChanged.content.find((node) => node.attrs?.id === 'channels-figure').attrs.label,
		'fig:external-change',
	)
	// Returning to the original base is still a pending edit after an external replacement.
	await label.fill('fig:channels')
	await label.press('Enter')
	assert.equal(await label.inputValue(), 'fig:channels')
	assert.equal(await label.getAttribute('data-typst-unapplied'), 'true')
	assert.deepEqual(await body.evaluate(doc), externallyChanged)
	await figure.getByRole('alert').filter({ hasText: '其他位置修改' }).waitFor()
	await figure.getByRole('button', { name: '恢复 label', exact: true }).click()
	assert.equal(await label.inputValue(), 'fig:external-change')
	assert.equal(await label.getAttribute('data-typst-unapplied'), null)
	await bodyPanel.getByRole('button', { name: '撤销', exact: true }).click()
	await current()
	assert.deepEqual(await body.evaluate(doc), original)

	// IME composition must not commit a partial label when Enter confirms composition.
	await label.fill('fig:composing')
	await label.dispatchEvent('compositionstart', { data: '输入' })
	await label.press('Enter')
	assert.deepEqual(await body.evaluate(doc), original)
	await label.dispatchEvent('compositionend', { data: '输入' })
	await label.press('Escape')
	assert.equal(await label.inputValue(), 'fig:channels')

	// Leaving a valid table label commits one change; invalid blur keeps the admitted document.
	const tableFigureView = body.locator('[data-figure-id="observations-table"]')
	const tableLabel = tableFigureView.getByRole('textbox', { name: '表引用 label', exact: true })
	await tableLabel.fill('tbl:renamed-observations')
	await tableLabel.press('Tab')
	await current()
	assert.match(
		await notesPanel.locator('.typst-reference').nth(1).textContent(),
		/tbl:renamed-observations/,
	)
	await bodyPanel.getByRole('button', { name: '撤销', exact: true }).click()
	await current()
	assert.deepEqual(await body.evaluate(doc), original)
	await tableLabel.fill('fig:channels')
	await tableLabel.press('Tab')
	await tableFigureView.getByRole('alert').filter({ hasText: '相同 label' }).waitFor()
	assert.equal(await tableLabel.inputValue(), 'fig:channels')
	assert.deepEqual(await body.evaluate(doc), original)
	await tableLabel.press('Escape')
	assert.equal(await tableLabel.inputValue(), 'tbl:observations')
	assert.equal(await tableFigureView.getByRole('alert').count(), 0)

	await figure.locator('figcaption').scrollIntoViewIfNeeded()
	await captionRow(figure, label)
	await page.screenshot({ path: join(output, 'desktop-figure-row.png'), fullPage: true })
	await tableFigureView.locator('figcaption').scrollIntoViewIfNeeded()
	await captionRow(tableFigureView, tableLabel)
	await page.screenshot({ path: join(output, 'desktop-table-row.png'), fullPage: true })

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

	// Equation labels use the same field contract, independently of the LaTeX source.
	const equation = body.locator('[data-equation-id="attainment-equation"]')
	const equationLabel = equation.getByRole('textbox', { name: '公式引用 label', exact: true })
	await equationLabel.waitFor({ state: 'visible' })
	await equationLabel.fill('eq:variance')
	await equationLabel.press('Enter')
	await current()
	assert.match(await notesPanel.locator('.typst-reference').last().textContent(), /eq:variance/)
	const renamedEquation = await body.evaluate(doc)
	const equationBefore = original.content.find((node) => node.attrs?.id === 'attainment-equation')
	assert.equal(
		renamedEquation.content.find((node) => node.attrs?.id === 'attainment-equation').attrs.latex,
		equationBefore.attrs.latex,
	)
	await bodyPanel.getByRole('button', { name: '撤销', exact: true }).click()
	await current()
	assert.deepEqual(await body.evaluate(doc), original)

	// A formula draft renders in its own node without writing the document until committed.
	const equationButton = equation.getByRole('button', { name: '编辑独立公式', exact: true })
	const latex = equation.getByRole('textbox', { name: '公式 LaTeX', exact: true })
	await equationButton.click()
	await latex.waitFor({ state: 'visible' })
	assert.equal(await latex.evaluate((element) => element.closest('[popover]')), null)
	await latex.fill('r = \\frac{A-T}{T}')
	assert.deepEqual(await body.evaluate(doc), original)
	assert.equal(await latex.getAttribute('data-typst-unapplied'), 'true')
	assert.equal(
		await equation.locator('annotation[encoding="application/x-tex"]').textContent(),
		'r = \\frac{A-T}{T}',
	)
	await latex.press('ControlOrMeta+Enter')
	await latex.waitFor({ state: 'hidden' })
	await current()
	const formulaDocument = await body.evaluate(doc)
	assert.equal(
		formulaDocument.content.find((node) => node.attrs?.id === 'attainment-equation').attrs.latex,
		'r = \\frac{A-T}{T}',
	)
	assert.equal(
		formulaDocument.content.find((node) => node.attrs?.id === 'attainment-equation').attrs.label,
		'eq:attainment',
	)
	await bodyPanel.getByRole('button', { name: '撤销', exact: true }).click()
	await current()
	assert.deepEqual(await body.evaluate(doc), original)

	await equationButton.click()
	await latex.fill('x = 2')
	await latex.press('Escape')
	await latex.waitFor({ state: 'hidden' })
	assert.deepEqual(await body.evaluate(doc), original)
	assert.equal(await equation.locator('[data-typst-unapplied="true"]').count(), 0)

	// Inline formula editing also stays in the paragraph; blur commits and cancel does not.
	const inline = body.locator('.typst-inline-math').first()
	const inlineButton = inline.getByRole('button', { name: '编辑行内公式', exact: true })
	const inlineLatex = inline.getByRole('textbox', { name: '公式 LaTeX', exact: true })
	await inlineButton.click()
	await inlineLatex.waitFor({ state: 'visible' })
	assert.equal(await inlineLatex.evaluate((element) => element.closest('[popover]')), null)
	await inlineLatex.fill('r_{net}')
	await equationLabel.focus()
	await inlineLatex.waitFor({ state: 'hidden' })
	await current()
	const inlineDocument = await body.evaluate(doc)
	assert.match(JSON.stringify(inlineDocument), /r_\{net\}/)
	assert.equal(
		inlineDocument.content.find((node) => node.attrs?.id === 'attainment-equation').attrs.label,
		'eq:attainment',
	)
	await bodyPanel.getByRole('button', { name: '撤销', exact: true }).click()
	await current()
	assert.deepEqual(await body.evaluate(doc), original)
	await inlineButton.click()
	await inlineLatex.fill('r_{cancelled}')
	await inline.getByRole('button', { name: '取消', exact: true }).click()
	await inlineLatex.waitFor({ state: 'hidden' })
	assert.deepEqual(await body.evaluate(doc), original)

	// Read-only keeps labels locked while formula source remains inspectable.
	const readOnly = page.getByRole('checkbox', { name: '区域只读', exact: true })
	await readOnly.check()
	assert.equal(await label.isEditable(), false)
	assert.equal(await tableLabel.isEditable(), false)
	assert.equal(await equationLabel.isEditable(), false)
	await equationButton.click()
	await latex.waitFor({ state: 'visible' })
	assert.equal(await latex.isEditable(), false)
	assert.equal(await latex.inputValue(), equationBefore.attrs.latex)
	await equation.getByRole('button', { name: '取消', exact: true }).focus()
	await page.keyboard.press('Escape')
	await latex.waitFor({ state: 'hidden' })
	await readOnly.uncheck()
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

	// Source editing remains inside its object in dark mode and on narrow screens.
	await page.emulateMedia({ colorScheme: 'dark' })
	await equationButton.click()
	await latex.fill(
		`r = ${Array.from({ length: 35 }, (_, index) => `x_{${index + 1}}`).join(' + ')}`,
	)
	await bounded()
	await latex.scrollIntoViewIfNeeded()
	await page.screenshot({ path: join(output, 'desktop-math-dark.png'), fullPage: true })
	await page.setViewportSize({ width: 390, height: 844 })
	await latex.scrollIntoViewIfNeeded()
	await bounded()
	assert.equal(
		await latex.evaluate((element) => {
			const field = element.getBoundingClientRect()
			const object = element.closest('.typst-block-math').getBoundingClientRect()
			return (
				field.left >= object.left - 1 &&
				field.right <= object.right + 1 &&
				field.right <= innerWidth
			)
		}),
		true,
	)
	await page.screenshot({ path: join(output, 'mobile-math-dark.png'), fullPage: true })
	await latex.press('Escape')
	await inlineButton.click()
	await inlineLatex.fill('r_{net}')
	await inlineLatex.scrollIntoViewIfNeeded()
	await bounded()
	assert.equal(
		await inlineLatex.evaluate((element) => {
			const field = element.getBoundingClientRect()
			return field.left >= 0 && field.right <= innerWidth
		}),
		true,
	)
	await page.screenshot({ path: join(output, 'mobile-inline-math-dark.png'), fullPage: true })
	await inlineLatex.press('Escape')
	await figure.locator('figcaption').scrollIntoViewIfNeeded()
	await bounded()
	await captionRow(figure, label)
	await page.screenshot({ path: join(output, 'mobile-figure-row-dark.png'), fullPage: true })
	await tableFigureView.locator('figcaption').scrollIntoViewIfNeeded()
	await bounded()
	await captionRow(tableFigureView, tableLabel)
	await page.screenshot({ path: join(output, 'mobile-table-row-dark.png'), fullPage: true })
	await page.emulateMedia({ colorScheme: 'light' })
	await page.setViewportSize({ width: 1440, height: 1000 })

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
