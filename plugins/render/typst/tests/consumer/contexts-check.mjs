import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { trackConsumerSessions } from './browser-session.mjs'

const output = await mkdtemp(join(tmpdir(), 'typst-contexts-ui-'))
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } })
const releaseSessions = trackConsumerSessions(page)
page.on('dialog', (dialog) => dialog.accept())
const errors = []
page.on('pageerror', (error) => errors.push(String(error)))
const body = page.getByTestId('region-body').locator('.tiptap')
const textMenu = page.getByRole('toolbar', { name: '选区格式', exact: true })
const tableMenu = page.getByRole('dialog', { name: '表格操作', exact: true })
const cellTools = tableMenu.getByRole('toolbar', { name: '单元格文字格式', exact: true })
const blockMenu = page.getByRole('menu', { name: '块操作', exact: true })
const selection = () => body.evaluate((element) => element.editor.state.selection.toJSON())
const snapshot = () => body.evaluate((element) => element.editor.getJSON())
const undo = () =>
	page
		.getByTestId('region-body')
		.getByRole('toolbar', { name: '正文格式', exact: true })
		.getByRole('button', { name: '撤销', exact: true })
		.click()
async function current() {
	await page
		.getByTestId('revision')
		.filter({ hasText: / · 当前$/ })
		.waitFor({ timeout: 60000 })
	assert.equal(await page.getByRole('alert').count(), 0)
}
async function settled() {
	await page.evaluate(
		() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
	)
}
async function selectText(text, length = text.length) {
	const range = await body.evaluate(
		(element, target) => {
			const editor = element.editor
			let from
			editor.state.doc.descendants((node, offset) => {
				if (from === undefined && node.isText && node.text.includes(target.text))
					from = offset + node.text.indexOf(target.text)
			})
			if (from === undefined) throw new Error(`Missing selection text: ${target.text}`)
			const to = from + target.length
			editor.chain().setTextSelection({ from, to }).focus().scrollIntoView().run()
			return { from, to }
		},
		{ text, length },
	)
	await settled()
	return range
}
async function pointAt(position) {
	return body.evaluate((element, pos) => {
		const box = element.editor.view.coordsAtPos(pos)
		return { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 }
	}, position)
}
async function rightAt(position) {
	const point = await pointAt(position)
	await page.mouse.click(point.x, point.y, { button: 'right' })
}
async function contextPrevented(target) {
	return target.evaluate((element) => {
		const bounds = element.getBoundingClientRect()
		const event = new MouseEvent('contextmenu', {
			bubbles: true,
			cancelable: true,
			clientX: bounds.left + 6,
			clientY: bounds.top + 6,
			button: 2,
		})
		element.dispatchEvent(event)
		return event.defaultPrevented
	})
}
async function noOverlap(expected) {
	await settled()
	assert.equal(await textMenu.isVisible(), expected === 'text', `${expected}: text menu visibility`)
	assert.equal(
		await tableMenu.isVisible(),
		expected === 'table',
		`${expected}: table menu visibility`,
	)
	assert.equal(
		await blockMenu.isVisible(),
		expected === 'block',
		`${expected}: block menu visibility`,
	)
}
try {
	await page.goto(process.env.PLUXEL_TYPST_URL ?? 'http://typst.pluxel.localhost:8088')
	await current()
	const original = await snapshot()
	const heading = await selectText('Editable', 8)
	await noOverlap(null)
	await rightAt(heading.from + 4)
	await textMenu.waitFor()
	assert.deepEqual(
		await selection(),
		{ type: 'text', anchor: heading.from, head: heading.to },
		'Right-clicking inside a selection preserves its full range',
	)
	await noOverlap('text')
	await page.screenshot({ path: join(output, 'text-context-desktop.png'), fullPage: true })
	await textMenu.getByRole('button', { name: '加粗', exact: true }).click()
	assert.equal(await body.locator('h2 strong').innerText(), 'Editable')
	await current()
	await undo()
	assert.deepEqual(await snapshot(), original)
	await current()

	await selectText('Editable', 8)
	const outside = await body.evaluate((element) => {
		let position
		element.editor.state.doc.descendants((node, offset) => {
			if (node.isText && node.text.startsWith('Prepared for ')) position = offset + 4
		})
		return position
	})
	const hit = await pointAt(outside)
	const expectedCaret = await body.evaluate(
		(element, point) => element.editor.view.posAtCoords({ left: point.x, top: point.y }).pos,
		hit,
	)
	await rightAt(outside)
	await textMenu.waitFor()
	assert.deepEqual(
		await selection(),
		{ type: 'text', anchor: expectedCaret, head: expectedCaret },
		'A right-click outside the selection moves the caret to its target',
	)
	await page.keyboard.press('Escape')
	await textMenu.waitFor({ state: 'hidden' })
	await page.keyboard.press('Shift+F10')
	await textMenu.waitFor()
	await page.keyboard.press('Escape')
	await textMenu.waitFor({ state: 'hidden' })
	await page.keyboard.press('ContextMenu')
	await textMenu.waitFor()
	await noOverlap('text')

	// Cell text and table operations share one panel; selection tools never overlap it.
	const cell = await selectText('First paragraph', 5)
	await rightAt(cell.from + 2)
	await tableMenu.waitFor()
	await cellTools.waitFor()
	await noOverlap('table')
	assert.deepEqual(await selection(), { type: 'text', anchor: cell.from, head: cell.to })
	await page.screenshot({ path: join(output, 'table-context-desktop.png'), fullPage: true })
	await cellTools.getByRole('button', { name: '加粗', exact: true }).click()
	assert.equal(await body.locator('td strong').innerText(), 'First')
	await current()
	await undo()
	assert.deepEqual(await snapshot(), original)
	await current()
	await body.evaluate((element) => {
		const editor = element.editor
		let position
		editor.state.doc.descendants((node, offset) => {
			if (position === undefined && node.type.name === 'tableCell') position = offset
		})
		editor.commands.setCellSelection({ anchorCell: position })
		editor.view.focus()
	})
	await page.keyboard.press('Shift+F10')
	await tableMenu.waitFor()
	assert.equal(
		await cellTools.isVisible(),
		false,
		'CellSelection has table actions without a misleading text toolbar',
	)
	await page.keyboard.press('Escape')
	await tableMenu.waitFor({ state: 'hidden' })

	// Read-only and composition keep ordinary text right-click native.
	await selectText('Editable', 8)
	await page.getByRole('checkbox', { name: '区域只读', exact: true }).check()
	assert.equal(await contextPrevented(body.locator('h2')), false)
	await noOverlap(null)
	await page.getByRole('checkbox', { name: '区域只读', exact: true }).uncheck()
	await body.dispatchEvent('compositionstart', { data: '' })
	assert.equal(await contextPrevented(body.locator('h2')), false)
	await noOverlap(null)
	await body.dispatchEvent('compositionend', { data: '' })

	await page.getByRole('combobox', { name: '示例', exact: true }).selectOption('operations-report')
	const chart = body.locator('[data-block-id="channels-primary"]')
	await chart.waitFor()
	await current()
	const analysis = await selectText('经营解读', 4)
	await rightAt(analysis.from + 2)
	await textMenu.waitFor()
	await chart.locator('.typst-block-title').click({ button: 'right' })
	await blockMenu.waitFor()
	await noOverlap('block')
	assert.equal(
		await blockMenu.evaluate((element) => element.contains(document.activeElement)),
		true,
		'Right-clicking a block leaves keyboard focus inside its menu',
	)
	await page.keyboard.press('Escape')
	await blockMenu.waitFor({ state: 'hidden' })
	await noOverlap(null)
	await chart.locator('.typst-block-title').click({ button: 'right' })
	await blockMenu.waitFor()
	const reportCell = await selectText('观察', 2)
	await rightAt(reportCell.from + 1)
	await tableMenu.waitFor()
	await noOverlap('table')
	await selectText('经营解读', 4)
	await rightAt(analysis.from + 2)
	await textMenu.waitFor()
	await noOverlap('text')
	await page.keyboard.press('Escape')

	// Native text inputs embedded in an atom retain their own context menu and focus.
	await page
		.getByRole('navigation', { name: '正文区域', exact: true })
		.getByRole('button', { name: '后续行动', exact: true })
		.click()
	const sourceCard = page.getByTestId('region-notes').locator('[data-block-id="source-note"]')
	await sourceCard.locator('summary').click()
	const sourceInput = sourceCard.getByRole('textbox', { name: '组件 Typst 源码', exact: true })
	await sourceInput.click()
	assert.equal(await contextPrevented(sourceInput), false)
	assert.equal(await sourceInput.evaluate((element) => element === document.activeElement), true)
	await noOverlap(null)
	await sourceInput.click({ button: 'right' })
	await noOverlap(null)
	await page.keyboard.press('Escape')

	await page
		.getByRole('navigation', { name: '正文区域', exact: true })
		.getByRole('button', { name: '经营解读', exact: true })
		.click()
	await page.setViewportSize({ width: 390, height: 844 })
	const mobileText = await selectText('经营解读', 4)
	await rightAt(mobileText.from + 2)
	await textMenu.waitFor()
	let bounds = await textMenu.boundingBox()
	assert.ok(
		bounds &&
			bounds.x >= 0 &&
			bounds.y >= 0 &&
			bounds.x + bounds.width <= 390 &&
			bounds.y + bounds.height <= 844,
	)
	await page.screenshot({ path: join(output, 'text-context-mobile.png') })
	await page.keyboard.press('Escape')
	const mobileCell = await selectText('观察', 2)
	await rightAt(mobileCell.from + 1)
	await tableMenu.waitFor()
	await noOverlap('table')
	bounds = await tableMenu.boundingBox()
	assert.ok(
		bounds &&
			bounds.x >= 0 &&
			bounds.y >= 0 &&
			bounds.x + bounds.width <= 390 &&
			bounds.y + bounds.height <= 844,
	)
	await page.screenshot({ path: join(output, 'table-context-mobile.png') })
	assert.deepEqual(errors, [])
	await writeFile(join(output, 'result.json'), JSON.stringify({ errors }, null, 2))
	console.log(JSON.stringify({ output, errors }))
} catch (error) {
	await page.screenshot({ path: join(output, 'failure.png'), fullPage: true })
	console.error({ output, errors, text: await page.locator('body').innerText() })
	throw error
} finally {
	try {
		await page.goto('about:blank')
		await releaseSessions()
	} finally {
		await browser.close()
	}
}
