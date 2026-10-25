import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { trackConsumerSessions } from './browser-session.mjs'
const dir = await mkdtemp(join(tmpdir(), 'typst-format-ui-'))
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } })
const release = trackConsumerSessions(page)
const errors = []
page.on('pageerror', (error) => errors.push(String(error)))
const body = page.getByTestId('region-body').locator('.tiptap')
const toolbar = page
	.getByTestId('region-body')
	.getByRole('toolbar', { name: '正文格式', exact: true })
const menu = page.getByRole('dialog', { name: '文字格式', exact: true })
const snapshot = () => body.evaluate((el) => el.editor.getJSON())
async function settle() {
	await page.evaluate(
		() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
	)
}
async function select(start, end = start) {
	await body.evaluate(
		(el, range) => {
			el.editor.commands.setTextSelection(range)
			el.editor.view.focus()
		},
		{ from: start, to: end },
	)
	await settle()
}
async function undo() {
	await toolbar.getByRole('button', { name: '撤销', exact: true }).click()
	await settle()
}
const passed = []
try {
	await page.goto(process.env.PLUXEL_TYPST_URL ?? 'http://typst.pluxel.localhost:8088')
	await page
		.getByTestId('revision')
		.filter({ hasText: / · 当前$/ })
		.waitFor({ timeout: 60000 })
	const { from, to } = await body.evaluate((el) => {
		let position
		el.editor.state.doc.descendants((n, p) => {
			if (position === undefined && n.isText && n.text.includes('Editable'))
				position = p + n.text.indexOf('Editable')
		})
		return { from: position, to: position + 8 }
	})
	assert.equal(typeof from, 'number')
	const original = await snapshot()
	await select(from, to)
	await toolbar.getByRole('button', { name: '格式', exact: true }).click()
	await menu.waitFor()
	assert.deepEqual(await body.evaluate((el) => el.editor.state.selection.toJSON()), {
		type: 'text',
		anchor: from,
		head: to,
	})
	const snapshots = [original]
	await menu.getByRole('button', { name: '加粗', exact: true }).click()
	assert.equal(await body.locator('h2 strong').innerText(), 'Editable')
	assert.equal(await menu.isVisible(), true)
	snapshots.push(await snapshot())
	await menu.getByRole('combobox', { name: '字体', exact: true }).selectOption('Noto Serif CJK SC')
	assert.equal(await menu.isVisible(), true)
	snapshots.push(await snapshot())
	await menu.getByRole('combobox', { name: '字号', exact: true }).selectOption('18pt')
	assert.equal(await menu.isVisible(), true)
	snapshots.push(await snapshot())
	await menu.getByRole('button', { name: '文字颜色', exact: true }).click()
	const palette = page.getByRole('dialog', { name: '文字颜色', exact: true })
	await palette.getByRole('button', { name: '蓝色', exact: true }).click()
	assert.equal(await menu.isVisible(), true)
	assert.equal(await palette.isVisible(), false)
	assert.deepEqual(await body.evaluate((el) => el.editor.state.selection.toJSON()), {
		type: 'text',
		anchor: from,
		head: to,
	})
	await page.screenshot({ path: `${dir}/continuous-format.png`, fullPage: true })
	for (let i = snapshots.length - 1; i >= 0; i--) {
		await undo()
		assert.deepEqual(await snapshot(), snapshots[i])
	}
	passed.push(
		'visible format entry preserves selection; bold, font, size and color stay open with one undo each',
	)
	await select(from, to)
	await page.keyboard.press('Shift+F10')
	await menu.waitFor()
	await menu.getByRole('button', { name: '背景颜色', exact: true }).click()
	await page.keyboard.press('ArrowLeft')
	assert.equal(
		await page.evaluate(() => document.activeElement?.getAttribute('aria-label')),
		'白色',
	)
	await page.keyboard.press('Escape')
	assert.equal(await page.getByRole('dialog', { name: '背景颜色', exact: true }).isVisible(), false)
	assert.equal(await menu.isVisible(), true)
	await page.keyboard.press('Escape')
	assert.equal(await menu.isVisible(), false)
	assert.equal(await body.evaluate((el) => el.editor.view.hasFocus()), true)
	passed.push('keyboard entry and nested Escape restore native editor focus')
	await select(to)
	await toolbar.getByRole('button', { name: '格式', exact: true }).click()
	await menu.waitFor()
	await menu.getByRole('button', { name: '加粗', exact: true }).click()
	await page.keyboard.press('Escape')
	await page.keyboard.insertText('X')
	assert.equal(await body.locator('h2 strong').innerText(), 'X')
	await undo()
	assert.deepEqual(await snapshot(), original)
	passed.push('caret formatting applies to subsequent typing')
	await select(from, to)
	const box = await body.evaluate((el, p) => el.editor.view.coordsAtPos(p), from + 3)
	await page.mouse.click(box.left, (box.top + box.bottom) / 2, { button: 'right' })
	await menu.waitFor()
	assert.deepEqual(await body.evaluate((el) => el.editor.state.selection.toJSON()), {
		type: 'text',
		anchor: from,
		head: to,
	})
	const size = menu.getByRole('combobox', { name: '字号', exact: true })
	await size.focus()
	await size.press('ArrowDown')
	await settle()
	assert.equal(await menu.isVisible(), true)
	assert.equal(await size.evaluate((el) => el === el.ownerDocument.activeElement), true)
	await page.keyboard.press('Escape')
	await undo()
	assert.deepEqual(await snapshot(), original)
	passed.push('right click shares range; native select retains keyboard ownership')
	await page.setViewportSize({ width: 360, height: 740 })
	await select(from, to)
	await toolbar.getByRole('button', { name: '格式', exact: true }).click()
	await menu.waitFor()
	await menu.getByRole('button', { name: '背景颜色', exact: true }).click()
	const color = page.getByRole('dialog', { name: '背景颜色', exact: true })
	await color.waitFor()
	await color.getByRole('textbox', { name: '色值', exact: true }).fill('#112233')
	await page.screenshot({ path: `${dir}/mobile-format.png`, fullPage: true })
	const bounds = await menu.boundingBox()
	assert.ok(
		bounds.x >= 0 &&
			bounds.x + bounds.width <= 360 &&
			bounds.y >= 0 &&
			bounds.y + bounds.height <= 740,
	)
	await color.getByRole('button', { name: '应用', exact: true }).click()
	assert.equal(await menu.isVisible(), true)
	await page.keyboard.press('Escape')
	await undo()
	assert.deepEqual(await snapshot(), original)
	passed.push('narrow screen nested palette remains usable and within viewport')

	await page.setViewportSize({ width: 1440, height: 1100 })
	const tableRange = await body.evaluate((el) => {
		let position
		el.editor.state.doc.descendants((node, at) => {
			if (position === undefined && node.isText && node.text.includes('Merged heading'))
				position = at
		})
		return { from: position, to: position + 6 }
	})
	await select(tableRange.from, tableRange.to)
	await page.keyboard.press('Shift+F10')
	const tableMenu = page.getByRole('dialog', { name: '表格操作', exact: true })
	await tableMenu.waitFor()
	assert.equal(await menu.isVisible(), false)
	await tableMenu.getByRole('combobox', { name: '字号', exact: true }).selectOption('16pt')
	assert.equal(await tableMenu.isVisible(), true)
	assert.deepEqual(await body.evaluate((el) => el.editor.state.selection.toJSON()), {
		type: 'text',
		anchor: tableRange.from,
		head: tableRange.to,
	})
	await page.screenshot({ path: join(dir, 'table-format.png'), fullPage: true })
	await page.keyboard.press('Escape')
	await undo()
	assert.deepEqual(await snapshot(), original)
	passed.push('table text and structural actions share one context panel')
	async function mousePrevented(target, eventType) {
		return target.evaluate((element, kind) => {
			const rect = element.getBoundingClientRect()
			const event = new MouseEvent(kind, {
				bubbles: true,
				cancelable: true,
				button: 2,
				clientX: rect.left + 8,
				clientY: rect.top + 8,
			})
			element.dispatchEvent(event)
			return event.defaultPrevented
		}, eventType)
	}
	await select(from, to)
	await toolbar.getByRole('button', { name: '格式', exact: true }).click()
	await menu.waitFor()
	await body.dispatchEvent('compositionstart', { data: '拼' })
	await settle()
	assert.equal(await menu.isVisible(), false)
	assert.equal(await toolbar.getByRole('button', { name: '格式', exact: true }).isDisabled(), true)
	for (const target of [body.locator('h2'), body.locator('td, th').first()]) {
		assert.equal(
			await mousePrevented(target, 'mousedown'),
			false,
			'IME keeps native right-button selection handling',
		)
		assert.equal(
			await mousePrevented(target, 'contextmenu'),
			false,
			'IME keeps native context handling',
		)
	}
	await body.dispatchEvent('compositionend', { data: '拼' })
	await settle()
	assert.equal(await toolbar.getByRole('button', { name: '格式', exact: true }).isDisabled(), false)
	assert.deepEqual(await snapshot(), original)
	passed.push(
		'composition closes open panels and preserves native context events, including tables',
	)
	await page.getByRole('checkbox', { name: '区域只读', exact: true }).check()
	await settle()
	assert.equal(await toolbar.getByRole('button', { name: '格式', exact: true }).isDisabled(), true)
	assert.equal(await mousePrevented(body.locator('h2'), 'contextmenu'), false)
	await body.locator('td, th').first().click({ button: 'right' })
	await tableMenu.waitFor()
	assert.equal(
		await tableMenu.getByRole('button', { name: '增加行', exact: true }).isDisabled(),
		true,
	)
	assert.equal(
		await tableMenu.getByRole('combobox', { name: '字号', exact: true }).isDisabled(),
		true,
	)
	await page.keyboard.press('Escape')
	assert.deepEqual(await snapshot(), original)
	await page.getByRole('checkbox', { name: '区域只读', exact: true }).uncheck()
	passed.push(
		'readonly text keeps the browser menu and table properties remain inspectable without editing',
	)

	await select(from, to)
	await toolbar.getByRole('button', { name: '格式', exact: true }).click()
	await menu.getByRole('button', { name: '加粗', exact: true }).click()
	await page.getByRole('tab', { name: '正文', exact: true }).click()
	for (const action of ['撤销', '重做']) {
		await toolbar.getByRole('button', { name: action, exact: true }).click()
		// Start keyboard selection immediately; a delayed focus must not restore the old caret.
		await body.press('ArrowRight')
		await body.press('Shift+ArrowLeft')
		await settle()
		assert.equal(await page.evaluate(() => window.getSelection()?.toString()), 'e', action)
		assert.deepEqual(
			await body.evaluate((el) => el.editor.state.selection.toJSON()),
			{ type: 'text', anchor: 9, head: 8 },
			action,
		)
	}
	await undo()
	assert.deepEqual(await snapshot(), original)
	passed.push('undo and redo do not queue a focus that overwrites the next keyboard selection')

	assert.deepEqual(errors, [])
	await writeFile(`${dir}/result.json`, JSON.stringify({ passed, errors }, null, 2))
	console.log(JSON.stringify({ output: dir, passed, errors }))
} catch (error) {
	await page.screenshot({ path: `${dir}/failure.png`, fullPage: true }).catch(() => {})
	await writeFile(`${dir}/failure.html`, await page.content())
	await writeFile(
		`${dir}/result.json`,
		JSON.stringify({ passed, errors, error: String(error) }, null, 2),
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
