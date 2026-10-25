import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { trackConsumerSessions } from './browser-session.mjs'

const output =
	process.env.PLUXEL_TYPST_TABLE_TOOLS_OUTPUT ??
	(await mkdtemp(join(tmpdir(), 'typst-table-tools-')))
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, hasTouch: true })
const release = trackConsumerSessions(page)
const errors = []
const checks = []
page.on('pageerror', (error) => errors.push(String(error)))
const region = page.getByTestId('region-body')
const body = region.locator('.tiptap')
const toolbar = region.getByRole('toolbar', { name: '正文格式', exact: true })
const tools = region.getByRole('toolbar', { name: '表格快捷操作', exact: true })
const dialog = page.getByRole('dialog', { name: '插入表格', exact: true })
const rows = dialog.getByRole('spinbutton', { name: '行数', exact: true })
const cols = dialog.getByRole('spinbutton', { name: '列数', exact: true })
const submit = dialog.getByRole('button', { name: '插入表格', exact: true })
const snapshot = () => body.evaluate((element) => element.editor.getJSON())
const paragraph = (text) => ({
	type: 'paragraph',
	...(text ? { content: [{ type: 'text', text }] } : {}),
})
const fixture = { type: 'doc', content: [paragraph('Before'), paragraph('After')] }
const settle = () =>
	page.evaluate(
		() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
	)
async function select(position) {
	await body.evaluate((element, at) => {
		element.editor.commands.setTextSelection(at)
		element.editor.view.focus()
	}, position)
	await settle()
}
async function reset(content = fixture) {
	await body.evaluate((element, doc) => element.editor.commands.setContent(doc), content)
	await select(1)
}
async function open() {
	await toolbar.getByRole('button', { name: '插入', exact: true }).click()
	await page
		.getByRole('dialog', { name: '插入内容', exact: true })
		.getByRole('option', { name: '表格', exact: true })
		.click()
	await dialog.waitFor()
	assert.equal(await rows.evaluate((element) => element === document.activeElement), true)
}
async function undo(expected) {
	await toolbar.getByRole('button', { name: '撤销', exact: true }).click()
	assert.deepEqual(await snapshot(), expected)
}
function table(doc) {
	return doc.content.find((node) => node.type === 'table')
}
try {
	await page.goto(process.env.PLUXEL_TYPST_URL ?? 'http://typst.pluxel.localhost:8088')
	await page
		.getByTestId('revision')
		.filter({ hasText: / · 当前$/ })
		.waitFor({ timeout: 60000 })
	await reset()
	const before = await snapshot()
	await select(7)
	await open()
	assert.equal(await rows.inputValue(), '3')
	assert.equal(await cols.inputValue(), '3')
	assert.equal(
		await dialog.getByRole('checkbox', { name: '首行为表头', exact: true }).isChecked(),
		true,
	)
	assert.deepEqual(await snapshot(), before, 'Opening dimensions does not edit content')
	for (const value of ['0', '51', '1.5']) {
		await rows.fill(value)
		await submit.click()
		assert.equal(await dialog.getByRole('alert').isVisible(), true)
		assert.deepEqual(await snapshot(), before)
	}
	await rows.fill('2')
	await cols.fill('21')
	await submit.click()
	assert.equal(await dialog.getByRole('alert').isVisible(), true)
	assert.deepEqual(await snapshot(), before)
	await cols.fill('4')
	await dialog.getByRole('checkbox', { name: '首行为表头', exact: true }).uncheck()
	await page.screenshot({ path: join(output, 'table-dimensions.png') })
	await cols.press('Enter')
	await dialog.waitFor({ state: 'hidden' })
	const inserted = await snapshot()
	assert.equal(table(inserted).content.length, 2)
	assert.ok(
		table(inserted).content.every(
			(row) => row.content.length === 4 && row.content.every((cell) => cell.type === 'tableCell'),
		),
	)
	assert.match(await tools.innerText(), /2 行 × 4 列/)
	await tools.getByRole('button', { name: '增加行', exact: true }).click()
	assert.equal(table(await snapshot()).content.length, 3)
	await undo(inserted)
	await tools.getByRole('button', { name: '增加列', exact: true }).click()
	assert.equal(table(await snapshot()).content[0].content.length, 5)
	await undo(inserted)
	await body.evaluate((element) => {
		const editor = element.editor
		let at = 0
		editor.state.doc.forEach((node, pos) => {
			if (node.type.name === 'table') at = pos
		})
		const first = at + 2
		editor.commands.setCellSelection({
			anchorCell: first,
			headCell: first + editor.state.doc.nodeAt(first).nodeSize,
		})
	})
	await tools.getByRole('button', { name: '合并单元格', exact: true }).click()
	const merged = await snapshot()
	assert.equal(table(merged).content[0].content[0].attrs.colspan, 2)
	await tools.getByRole('button', { name: '拆分单元格', exact: true }).click()
	assert.deepEqual(await snapshot(), inserted)
	await undo(merged)
	await undo(inserted)
	await tools.getByRole('button', { name: '更多表格操作', exact: true }).click()
	const full = page.getByRole('dialog', { name: '表格操作', exact: true })
	await full.waitFor()
	assert.equal(await full.getByRole('group', { name: '表格样式', exact: true }).isVisible(), true)
	await full.press('Escape')
	await page.screenshot({ path: join(output, 'table-context-tools.png') })
	await page.getByRole('checkbox', { name: '区域只读', exact: true }).check()
	assert.equal(await tools.getByRole('button', { name: '增加行', exact: true }).isDisabled(), true)
	await page.getByRole('checkbox', { name: '区域只读', exact: true }).uncheck()
	// IME starts from a text caret here. Native composition over CellSelection intentionally
	// clears the selected cells, even when they are empty, and creates its own undo event.
	await body.evaluate((element) => {
		const editor = element.editor
		editor.commands.setTextSelection(editor.state.selection.from + 1)
		editor.view.focus()
	})
	await settle()
	await body.dispatchEvent('compositionstart', { data: '拼' })
	assert.equal(await tools.getByRole('button', { name: '增加列', exact: true }).isDisabled(), true)
	await body.dispatchEvent('compositionend', { data: '拼' })
	assert.deepEqual(await snapshot(), inserted)
	await undo(before)
	checks.push(
		'dimensions-visible-errors-keyboard-native-history',
		'context-actions-cell-selection-readonly-ime-full-menu',
	)

	await select(7)
	await open()
	await rows.press('Escape')
	await dialog.waitFor({ state: 'hidden' })
	assert.deepEqual(await snapshot(), before)
	await open()
	await rows.press('Tab')
	assert.equal(await cols.evaluate((element) => element === document.activeElement), true)
	await page.keyboard.press('Tab')
	await page.keyboard.press('Tab')
	assert.equal(
		await dialog
			.getByRole('button', { name: '取消', exact: true })
			.evaluate((element) => element === document.activeElement),
		true,
	)
	await page.keyboard.press('Escape')
	await dialog.waitFor({ state: 'hidden' })
	assert.equal(
		await toolbar
			.getByRole('button', { name: '插入', exact: true })
			.evaluate((element) => element === document.activeElement),
		true,
	)
	assert.deepEqual(await snapshot(), before)
	await open()
	for (let index = 0; index < 5; index++) await page.keyboard.press('Tab')
	await dialog.waitFor({ state: 'hidden' })
	assert.deepEqual(await snapshot(), before, 'Tab past the last form control leaves no open popup')
	checks.push('table-form-native-tab-and-popup-escape')
	await open()
	await region.evaluate((element) => {
		element.hidden = true
	})
	await dialog.waitFor({ state: 'hidden' })
	await region.evaluate((element) => {
		element.hidden = false
	})
	assert.deepEqual(await snapshot(), before)
	await open()
	await body.evaluate((element) => element.editor.commands.setTextSelection(2))
	await dialog.waitFor({ state: 'hidden' })
	assert.deepEqual(await snapshot(), before)
	await open()
	await body.evaluate((element) => element.editor.commands.insertContent('External'))
	await dialog.waitFor({ state: 'hidden' })
	checks.push('cancel-hidden-and-stale-targets-do-not-insert')

	await reset({ type: 'doc', content: [paragraph(''), paragraph('After')] })
	await page.keyboard.insertText('/table')
	await body.press('Enter')
	await dialog.waitFor()
	assert.equal(await rows.evaluate((element) => element === document.activeElement), true)
	const slashQuery = await snapshot()
	await rows.press('Escape')
	await dialog.waitFor({ state: 'hidden' })
	assert.deepEqual(await snapshot(), slashQuery, 'Cancel preserves the slash query')
	await reset({ type: 'doc', content: [paragraph(''), paragraph('After')] })
	await page.keyboard.insertText('/table')
	await body.press('Enter')
	await dialog.waitFor()
	const slashBefore = await snapshot()
	await rows.fill('4')
	await cols.fill('2')
	await cols.dispatchEvent('compositionstart', { data: '2' })
	assert.equal(await submit.isDisabled(), true)
	await cols.dispatchEvent('keydown', { key: 'Escape' })
	assert.equal(await dialog.isVisible(), true, 'Form IME composition retains Escape')
	await cols.dispatchEvent('keydown', { key: 'Enter', isComposing: true })
	assert.deepEqual(await snapshot(), slashBefore)
	await cols.dispatchEvent('compositionend', { data: '2' })
	await cols.press('Enter')
	await dialog.waitFor({ state: 'hidden' })
	const slashTable = table(await snapshot())
	assert.equal(slashTable.content.length, 4)
	assert.equal(slashTable.content[0].content.length, 2)
	assert.ok(slashTable.content[0].content.every((cell) => cell.type === 'tableHeader'))
	await undo(slashBefore)
	checks.push('slash-dimensions-cancel-ime-and-one-undo-restores-query')

	await reset({
		type: 'doc',
		content: [
			paragraph(''),
			...Array.from({ length: 50 }, (_, index) => paragraph(`Line ${index}`)),
		],
	})
	await page.keyboard.insertText('/table')
	await body.press('Enter')
	await dialog.waitFor()
	const scrollingQuery = await snapshot()
	const scrolled = await region.locator('.typst-editor-content').evaluate((element) => {
		const previousTop = element.scrollTop
		element.scrollTop += 120
		return element.scrollTop - previousTop
	})
	assert.ok(scrolled > 0, 'The editor must actually scroll while the slash form is open')
	await dialog.waitFor({ state: 'hidden' })
	assert.deepEqual(
		await snapshot(),
		scrollingQuery,
		'Scrolling dismisses without editing the query',
	)
	checks.push('slash-dimensions-outside-scroll-closes-with-query-preserved')

	await reset()
	const localBefore = await snapshot()
	await page.keyboard.press('Alt+F10')
	await page.keyboard.press('Shift+Tab')
	assert.equal(
		await page.evaluate(() => document.activeElement?.getAttribute('aria-label')),
		'在块后插入',
	)
	await page.keyboard.press('Enter')
	await page
		.getByRole('dialog', { name: '插入内容', exact: true })
		.getByRole('option', { name: '表格', exact: true })
		.click()
	await dialog.waitFor()
	await rows.fill('1')
	await cols.fill('2')
	await submit.click()
	const local = await snapshot()
	assert.deepEqual(local.content[0], localBefore.content[0])
	assert.equal(local.content[1].type, 'table')
	assert.deepEqual(local.content[2], localBefore.content[1])
	assert.equal(local.content.length, 3, 'Local table insertion leaves no staging paragraph')
	await undo(localBefore)
	checks.push('block-local-dimensions-target-and-one-undo')

	await page.setViewportSize({ width: 320, height: 740 })
	await toolbar.getByRole('button', { name: '插入', exact: true }).scrollIntoViewIfNeeded()
	await toolbar.getByRole('button', { name: '插入', exact: true }).tap()
	await page
		.getByRole('dialog', { name: '插入内容', exact: true })
		.getByRole('option', { name: '表格', exact: true })
		.tap()
	await dialog.waitFor()
	const box = await dialog.boundingBox()
	assert.ok(
		box && box.x >= 0 && box.y >= 0 && box.x + box.width <= 320 && box.y + box.height <= 740,
	)
	await rows.fill('2')
	await cols.fill('2')
	await page.screenshot({ path: join(output, 'table-dimensions-mobile.png') })
	await submit.tap()
	assert.equal(table(await snapshot()).content.length, 2)
	await undo(localBefore)
	checks.push('320px-touch-dimensions')
	assert.deepEqual(errors, [])
	await writeFile(
		join(output, 'result.json'),
		JSON.stringify({ output, checks, pageErrors: errors }, null, 2),
	)
	console.log(JSON.stringify({ output, checks, pageErrors: errors }, null, 2))
} catch (error) {
	await page.screenshot({ path: join(output, 'failure.png'), fullPage: true })
	await writeFile(join(output, 'failure.html'), await page.content())
	await writeFile(
		join(output, 'failure.json'),
		JSON.stringify({ error: String(error), checks, pageErrors: errors }, null, 2),
	)
	throw error
} finally {
	try {
		await page.goto('about:blank')
		await release()
	} finally {
		await browser.close()
	}
}
