import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { trackConsumerSessions } from './browser-session.mjs'

const output = await mkdtemp(join(tmpdir(), 'typst-table-ui-'))
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } })
const releaseSessions = trackConsumerSessions(page)
page.on('dialog', (dialog) => dialog.accept())
const errors = []
let compiled
page.on('pageerror', (error) => errors.push(String(error)))
page.on('response', async (response) => {
	if (response.url().endsWith('/compile') && response.ok()) compiled = await response.json()
})
const body = page.getByRole('textbox', { name: '正文区域 body', exact: true })
const panel = page.getByRole('group', { name: '表格样式', exact: true })
const dialog = page.getByRole('dialog', { name: '表格操作', exact: true })
const toolbar = page
	.getByTestId('region-body')
	.getByRole('toolbar', { name: '正文格式', exact: true })
async function ready() {
	await page
		.getByTestId('revision')
		.filter({ hasText: / · 当前$/ })
		.waitFor({ timeout: 90000 })
	assert.equal(await page.getByRole('alert').count(), 0)
}
async function appearance(style) {
	await page.waitForFunction(
		(expected) =>
			document.querySelector('[data-testid="region-body"] .tableWrapper')?.dataset
				.typstTableAppearance === expected,
		style,
	)
	await ready()
}
async function openMenu() {
	if (!(await dialog.isVisible())) {
		await body.focus()
		await page.keyboard.press('Shift+F10')
		await dialog.waitFor()
	}
}
async function chooseStyle(label) {
	await openMenu()
	await panel.getByRole('button', { name: label, exact: true }).click()
	await dialog.waitFor({ state: 'hidden' })
}
async function clickPoint(point, expected) {
	const svg = page.locator('.typst-page').nth(point.page - 1)
	await svg.scrollIntoViewIfNeeded()
	const position = await svg.evaluate((element, target) => {
		const screen = new DOMPoint(
			target.x + target.width / 2,
			target.y + target.height / 2,
		).matrixTransform(element.getScreenCTM())
		return { x: screen.x, y: screen.y }
	}, point)
	await page.mouse.click(position.x, position.y)
	await page.waitForFunction(
		(pos) =>
			document.querySelector('[data-testid="region-body"] .tiptap').editor.state.selection.from ===
			pos,
		expected,
	)
}
try {
	const url = new URL(process.env.PLUXEL_TYPST_URL ?? 'http://typst.pluxel.localhost:8088')
	url.searchParams.set('example', 'consumer-report')
	await page.goto(url.href)
	await ready()
	await page.locator('.typst-page').first().waitFor()
	await body.locator('td').first().click({ button: 'right' })
	await panel.waitFor()
	assert.equal(
		await page
			.locator('.typst-toolbars')
			.getByRole('group', { name: '表格样式', exact: true })
			.count(),
		0,
	)
	// Appearance must not silently promote ordinary cells to headers.
	await chooseStyle('三线表')
	await appearance('three-line')
	await openMenu()
	await panel.getByText('设置表头后显示分隔线', { exact: true }).waitFor()
	assert.equal(await body.locator('th').count(), 0)
	await dialog.getByRole('button', { name: '切换表头', exact: true }).click()
	await body.locator('th').first().waitFor()
	await chooseStyle('跟随模板')
	await appearance('grid')
	const original = await body.evaluate((element) => element.editor.getJSON())
	const cases = []
	for (const [label, style] of [
		['三线表', 'three-line'],
		['网格·无左右框', 'grid-open-sides'],
		['无边框', 'borderless'],
		['网格', 'grid'],
	]) {
		await chooseStyle(label)
		await appearance(style)
		const content = await body.evaluate((element) => element.editor.getJSON())
		assert.equal(content.content.find((node) => node.type === 'table').attrs.tableStyle, style)
		assert.deepEqual(
			content.content.find((node) => node.type === 'table').content,
			original.content.find((node) => node.type === 'table').content,
		)
		const borders = await body.locator('table').evaluate((table) => ({
			top: getComputedStyle(table).borderTopWidth,
			bottom: getComputedStyle(table).borderBottomWidth,
			left: getComputedStyle(table.querySelector('td')).borderLeftWidth,
			header: getComputedStyle(table.querySelector('th')).borderBottomWidth,
		}))
		assert.equal(borders.left, style === 'grid' ? '1px' : '0px')
		if (style === 'grid-open-sides') {
			assert.equal(borders.header, '1px')
			assert.equal(
				await body
					.locator('tr')
					.last()
					.locator('td')
					.last()
					.evaluate((cell) => getComputedStyle(cell).borderRightWidth),
				'0px',
			)
		}
		if (style === 'three-line')
			assert.deepEqual(borders, { top: '2px', bottom: '2px', left: '0px', header: '1px' })
		await openMenu()
		await page.screenshot({ path: join(output, `${style}.png`), fullPage: true })
		await page.keyboard.press('Escape')
		await dialog.waitFor({ state: 'hidden' })
		cases.push({ style, borders })
	}
	await toolbar.getByRole('button', { name: '撤销', exact: true }).click()
	await appearance('borderless')
	await toolbar.getByRole('button', { name: '重做', exact: true }).click()
	await appearance('grid')
	// Native table/cell selections must survive an appearance-only transaction and undo.
	for (const kind of ['node', 'cell']) {
		const selection = await body.evaluate((element, selectionKind) => {
			const editor = element.editor
			let position
			editor.state.doc.descendants((node, pos) => {
				if (node.type.name === 'table') position ??= pos
			})
			if (selectionKind === 'node') editor.commands.setNodeSelection(position)
			else editor.commands.setCellSelection({ anchorCell: position + 2 })
			return editor.state.selection.toJSON()
		}, kind)
		// TableKit normalizes a whole-table NodeSelection to its native all-cell selection.
		assert.equal(selection.type, 'cell')
		await chooseStyle('无边框')
		await appearance('borderless')
		assert.deepEqual(
			await body.evaluate((element) => element.editor.state.selection.toJSON()),
			selection,
		)
		await toolbar.getByRole('button', { name: '撤销', exact: true }).click()
		await appearance('grid')
		assert.deepEqual(
			await body.evaluate((element) => element.editor.state.selection.toJSON()),
			selection,
		)
	}
	// Rowspans mean first/last child selectors would erase legitimate internal grid lines.
	const beforeMergedTable = await body.evaluate((element) => {
		const editor = element.editor
		const before = editor.getJSON()
		const cell = (text, attrs) => ({
			type: 'tableCell',
			attrs,
			content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
		})
		editor.commands.insertContentAt(editor.state.doc.content.size, {
			type: 'table',
			attrs: { tableStyle: 'grid-open-sides' },
			content: [
				[cell('Left', { rowspan: 2 }), cell('Top right', { colspan: 2 })],
				[cell('Middle'), cell('Right', { rowspan: 2 })],
				[cell('Bottom left', { colspan: 2 })],
			].map((content) => ({ type: 'tableRow', content })),
		})
		return before
	})
	await ready()
	const mergedBorders = await body
		.locator('table')
		.last()
		.locator('td')
		.evaluateAll((cells) =>
			cells.map((cell) => ({
				text: cell.textContent,
				left: getComputedStyle(cell).borderLeftWidth,
				right: getComputedStyle(cell).borderRightWidth,
			})),
		)
	assert.deepEqual(mergedBorders, [
		{ text: 'Left', left: '0px', right: '1px' },
		{ text: 'Top right', left: '1px', right: '0px' },
		{ text: 'Middle', left: '1px', right: '1px' },
		{ text: 'Right', left: '1px', right: '0px' },
		{ text: 'Bottom left', left: '0px', right: '1px' },
	])
	await toolbar.getByRole('button', { name: '撤销', exact: true }).click()
	assert.deepEqual(await body.evaluate((element) => element.editor.getJSON()), beforeMergedTable)
	await chooseStyle('网格·无左右框')
	await appearance('grid-open-sides')
	const html = await body.evaluate((element) => element.editor.getHTML())
	await page.getByRole('tab', { name: 'Markdown', exact: true }).click()
	await page.getByRole('button', { name: '编辑这份 Markdown', exact: true }).click()
	await page.getByRole('textbox', { name: '候选 Markdown', exact: true }).fill(html)
	await page.getByRole('button', { name: '检查 HTML', exact: true }).click()
	const imported = JSON.parse(await page.getByTestId('import-result').innerText())
	assert.equal(imported.ok, true, JSON.stringify(imported))
	assert.equal(
		imported.value.content.find((node) => node.type === 'table').attrs.tableStyle,
		'grid-open-sides',
	)
	await page.getByRole('button', { name: '放弃候选修改', exact: true }).click()
	await page.getByRole('tab', { name: '正文', exact: true }).click()
	await chooseStyle('三线表')
	await appearance('three-line')
	// Save/reopen must retain the attribute, while preview navigation still targets characters.
	await page.getByRole('button', { name: '保存', exact: true }).click()
	await page.getByRole('button', { name: '重开', exact: true }).click()
	await appearance('three-line')
	const caret = await body.evaluate((element) => {
		let result
		element.editor.state.doc.descendants((node, position) => {
			if (node.text === 'Second paragraph') result = position + 8
		})
		return result
	})
	const entry = compiled.mapping.find(
		(mapping) => mapping.kind === 'text' && mapping.from === caret,
	)
	const point = compiled.preview.navigation.points.find(
		(item) =>
			item.page === 1 &&
			item.path === entry.path &&
			item.line === entry.range.start.line &&
			item.column === entry.range.start.column,
	)
	await page.getByRole('tab', { name: 'Typst 预览', exact: true }).click()
	await clickPoint(point, caret)
	await body.locator('th').first().click()
	await page.getByRole('checkbox', { name: '区域只读', exact: true }).check()
	await body.locator('th').first().click({ button: 'right' })
	await dialog.waitFor()
	assert.equal(await panel.getByRole('button', { name: '无边框', exact: true }).isDisabled(), true)
	await page.keyboard.press('Escape')
	await page.getByRole('checkbox', { name: '区域只读', exact: true }).uncheck()
	await page.setViewportSize({ width: 390, height: 844 })
	await body.locator('th').first().click()
	await page.getByRole('button', { name: '表格操作', exact: true }).click()
	await dialog.waitFor()
	assert.equal(
		await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
		false,
	)
	const bounds = await dialog.boundingBox()
	assert.ok(
		bounds &&
			bounds.x >= 0 &&
			bounds.y >= 0 &&
			bounds.x + bounds.width <= 390 &&
			bounds.y + bounds.height <= 844,
	)
	await page.screenshot({ path: join(output, 'mobile.png') })
	await page.keyboard.press('Escape')
	await page.setViewportSize({ width: 1440, height: 1100 })
	const download = page.waitForEvent('download')
	await page.getByRole('button', { name: '导出当前 PDF', exact: true }).click()
	const downloaded = await download
	await downloaded.saveAs(join(output, 'three-line.pdf'))
	assert.deepEqual(errors, [])
	await writeFile(join(output, 'result.json'), JSON.stringify({ cases, caret, errors }, null, 2))
	console.log(JSON.stringify({ output, cases, caret, errors }, null, 2))
	await page.goto('about:blank')
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
