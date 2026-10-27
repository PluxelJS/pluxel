import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { trackConsumerSessions } from './browser-session.mjs'

const dir = await mkdtemp(join(tmpdir(), 'typst-block-actions-'))
const browser = await chromium.connect(
	process.env.PLAYWRIGHT_WS_ENDPOINT ?? 'ws://127.0.0.1:3000',
	{ timeout: 5000, exposeNetwork: '<loopback>' },
)
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, hasTouch: true })
const release = trackConsumerSessions(page)
const errors = []
const passed = []
page.on('pageerror', (error) => errors.push(String(error)))
const region = page.getByTestId('region-body')
const body = region.locator('.tiptap')
const toolbar = region.getByRole('toolbar', { name: '正文格式', exact: true })
const menu = page.getByRole('dialog', { name: '块操作', exact: true })
const snapshot = () => body.evaluate((el) => el.editor.getJSON())
const texts = () =>
	body.evaluate((el) => [...el.editor.state.doc.content.content].map((node) => node.textContent))
const paragraph = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })
let fixture = {
	type: 'doc',
	content: [paragraph('Alpha'), paragraph('Bravo'), paragraph('Charlie')],
}

async function settle() {
	await page.evaluate(
		() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
	)
}
async function reset(content = fixture) {
	await body.evaluate((el, doc) => el.editor.commands.setContent(doc), content)
	await settle()
}
async function select(index, offset = 1) {
	await body.evaluate(
		(el, [which, inside]) => {
			let pos = 0
			for (let i = 0; i < which; i++) pos += el.editor.state.doc.child(i).nodeSize
			el.editor.commands.setTextSelection(pos + inside)
			el.editor.view.focus()
		},
		[index, offset],
	)
	await settle()
}
async function hover(index) {
	await body
		.locator(':scope > *')
		.nth(index)
		.hover({ position: { x: 12, y: 10 } })
	await region
		.locator('.typst-block-drag')
		.getByRole('button', { name: '块操作', exact: true })
		.waitFor()
}
async function open(index) {
	await hover(index)
	await region
		.locator('.typst-block-drag')
		.getByRole('button', { name: '块操作', exact: true })
		.click()
	await menu.waitFor()
}
async function undo() {
	await toolbar.getByRole('button', { name: '撤销', exact: true }).click()
	await settle()
}
try {
	const url = new URL(process.env.PLUXEL_TYPST_URL ?? 'http://typst.pluxel.localhost:8088')
	url.searchParams.set('example', 'consumer-report')
	await page.goto(url.href)
	await page
		.getByTestId('revision')
		.filter({ hasText: / · 当前$/ })
		.waitFor({ timeout: 60000 })
	const original = await snapshot()
	await reset()
	fixture = await snapshot()
	await select(0)
	await open(1)
	assert.deepEqual(await body.evaluate((el) => el.editor.state.selection.toJSON()), {
		type: 'node',
		anchor: 7,
	})
	assert.match(await menu.innerText(), /Bravo/)
	await menu.getByRole('button', { name: '复制块', exact: true }).click()
	assert.deepEqual(await texts(), ['Alpha', 'Bravo', 'Bravo', 'Charlie'])
	await undo()
	assert.deepEqual(await snapshot(), fixture)
	passed.push(
		'hover target selects whole block and duplicates it, independent of original caret; one undo',
	)

	await open(1)
	await menu.getByRole('combobox', { name: '块类型', exact: true }).selectOption('heading-2')
	const converted = await snapshot()
	assert.deepEqual(
		converted.content.map((node) => node.type),
		['paragraph', 'heading', 'paragraph'],
	)
	assert.equal(converted.content[1].attrs.level, 2)
	await undo()
	assert.deepEqual(await snapshot(), fixture)
	for (const [label, expected] of [
		['上移块', ['Bravo', 'Alpha', 'Charlie']],
		['下移块', ['Alpha', 'Charlie', 'Bravo']],
		['删除块', ['Alpha', 'Charlie']],
	]) {
		await open(1)
		await menu.getByRole('button', { name: label, exact: true }).click()
		assert.deepEqual(await texts(), expected)
		await undo()
		assert.deepEqual(await snapshot(), fixture)
	}
	passed.push(
		'convert, move up/down and delete preserve unrelated blocks and each undo in one step',
	)

	await select(0)
	await hover(2)
	await page.keyboard.press('ArrowRight')
	await page.keyboard.press('Alt+F10')
	await page.getByRole('button', { name: '当前块操作', exact: true }).waitFor()
	assert.equal(
		await page.evaluate(() => document.activeElement?.getAttribute('aria-label')),
		'当前块操作',
	)
	await page.keyboard.press('Enter')
	await menu.waitFor()
	assert.match(await menu.innerText(), /Alpha/)
	assert.equal(await menu.getByRole('button', { name: '上移块', exact: true }).isDisabled(), true)
	await page.keyboard.press('Escape')
	assert.equal(await menu.isVisible(), false)
	assert.equal(await body.evaluate((el) => el.editor.view.hasFocus()), true)
	passed.push(
		'Alt+F10 reaches current native block after keyboard movement despite a previous different hover',
	)
	await page.keyboard.press('Alt+F10')
	await page.keyboard.press('Shift+Tab')
	assert.equal(
		await page.evaluate(() => document.activeElement?.getAttribute('aria-label')),
		'在块后插入',
	)
	await page.keyboard.press('Enter')
	await page.getByRole('dialog', { name: '插入内容', exact: true }).waitFor()
	assert.deepEqual(await snapshot(), fixture)
	await page.keyboard.press('Escape')
	assert.equal(await body.evaluate((el) => el.editor.view.hasFocus()), true)
	passed.push(
		'current-block plus stays mounted when its search receives portal focus, and Escape returns to the editor',
	)

	await hover(1)
	await region.getByRole('button', { name: '在块后插入', exact: true }).click()
	const insertion = page.getByRole('dialog', { name: '插入内容', exact: true })
	await insertion.waitFor()
	assert.deepEqual(await snapshot(), fixture)
	await insertion.getByRole('searchbox', { name: '搜索插入内容', exact: true }).fill('分隔线')
	const editorBox = await body.boundingBox()
	await page.mouse.move(editorBox.x + editorBox.width - 15, editorBox.y + 120)
	await page.getByRole('heading', { name: '编辑与排版', exact: true }).hover()
	assert.equal(
		await insertion
			.getByRole('option', { name: '分隔线', exact: true })
			.evaluate((el) => getComputedStyle(el).pointerEvents),
		'auto',
	)
	await insertion.getByRole('option', { name: '分隔线', exact: true }).click()
	const inserted = await snapshot()
	assert.deepEqual(
		inserted.content.map((node) => node.type),
		['paragraph', 'paragraph', 'horizontalRule', 'paragraph'],
	)
	await undo()
	assert.deepEqual(await snapshot(), fixture)
	passed.push(
		'inline plus reuses insertion without opening mutation and inserts at its block boundary in one undo',
	)

	const table = original.content.find((node) => node.type === 'table')
	assert.ok(table)
	const list = {
		type: 'bulletList',
		content: [
			{ type: 'listItem', content: [paragraph('List one')] },
			{ type: 'listItem', content: [paragraph('List two')] },
		],
	}
	let containers = {
		type: 'doc',
		content: [paragraph('Before'), list, table, paragraph('After')],
	}
	await reset(containers)
	containers = await snapshot()
	await open(1)
	await menu.getByRole('button', { name: '下移块', exact: true }).click()
	const movedList = await snapshot()
	assert.deepEqual(movedList.content, [
		containers.content[0],
		containers.content[2],
		containers.content[1],
		containers.content[3],
	])
	await undo()
	await open(2)
	assert.match(await menu.innerText(), /表格/)
	assert.equal(
		await menu
			.getByRole('combobox', { name: '块类型', exact: true })
			.locator('option[value="paragraph"]')
			.evaluate((el) => el.disabled),
		true,
	)
	await menu.getByRole('button', { name: '复制块', exact: true }).click()
	const copiedTable = await snapshot()
	assert.deepEqual(copiedTable.content, [
		containers.content[0],
		containers.content[1],
		containers.content[2],
		containers.content[2],
		containers.content[3],
	])
	await undo()
	assert.deepEqual(await snapshot(), containers)
	passed.push(
		'list and table handles target the complete top-level container, never a cell or list item',
	)

	await reset()
	await open(1)
	await body.evaluate((el) => el.editor.commands.insertContentAt(1, 'X'))
	await settle()
	assert.equal(await menu.isVisible(), false)
	await reset()
	await open(1)
	await page.getByRole('tab', { name: '数据', exact: true }).click()
	assert.equal(await menu.isVisible(), false)
	assert.equal(await page.locator('.typst-block-current:visible').count(), 0)
	await page.getByRole('tab', { name: '正文', exact: true }).click()
	await open(1)
	await body.dispatchEvent('compositionstart', { data: '拼' })
	await settle()
	assert.equal(await menu.isVisible(), false)
	assert.equal(
		await region
			.locator('.typst-block-drag')
			.getByRole('button', { name: '块操作', exact: true })
			.isVisible(),
		false,
	)
	await body.dispatchEvent('compositionend', { data: '拼' })
	await page.getByRole('checkbox', { name: '区域只读', exact: true }).check()
	await body.locator(':scope > p').nth(1).hover()
	assert.equal(
		await region
			.locator('.typst-block-drag')
			.getByRole('button', { name: '块操作', exact: true })
			.isVisible(),
		false,
	)
	assert.equal(await page.locator('.typst-block-current:visible').count(), 0)
	await page.getByRole('checkbox', { name: '区域只读', exact: true }).uncheck()
	passed.push(
		'external document changes, hidden region, composition and readonly close or hide block controls',
	)

	await reset()
	await select(0, 6)
	await page.keyboard.insertText('!')
	const typed = await snapshot()
	await hover(0)
	const grip = await region
		.locator('.typst-block-drag')
		.getByRole('button', { name: '块操作', exact: true })
		.boundingBox()
	const last = await body.locator(':scope > p').nth(2).boundingBox()
	assert.ok(grip && last)
	await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
	await page.mouse.down()
	await page.mouse.move(last.x + 24, last.y + last.height + 12, { steps: 12 })
	await page.mouse.move(last.x + 25, last.y + last.height + 13)
	await page.mouse.up()
	await settle()
	assert.deepEqual(await texts(), ['Bravo', 'Charlie', 'Alpha!'])
	await undo()
	assert.deepEqual(await snapshot(), typed)
	passed.push(
		'official native drag moves the whole block; one undo restores the prior typed document',
	)

	await reset({
		type: 'doc',
		content: Array.from({ length: 60 }, (_, i) => paragraph(`Scroll block ${i}`)),
	})
	await body
		.locator(':scope > p')
		.nth(8)
		.evaluate((el) => el.scrollIntoView({ block: 'center' }))
	await select(8)
	await page.keyboard.press('Alt+F10')
	const currentEntry = page.getByRole('button', { name: '当前块操作', exact: true })
	await currentEntry.waitFor()
	const beforeScroll = await currentEntry.boundingBox()
	await region.locator('.typst-editor-content').evaluate((el) => {
		el.scrollTop += 24
	})
	await settle()
	const afterScroll = await currentEntry.boundingBox()
	assert.ok(beforeScroll && afterScroll && Math.abs(beforeScroll.y - afterScroll.y - 24) < 2)
	await body
		.locator(':scope > p')
		.nth(8)
		.evaluate((el) => {
			const viewport = el.closest('.typst-editor-content')
			viewport.scrollTop +=
				el.getBoundingClientRect().bottom - viewport.getBoundingClientRect().top + 8
		})
	await settle()
	assert.equal(
		await currentEntry.isVisible(),
		false,
		'a block outside the editor viewport cannot leave a floating handle behind',
	)
	await hover(12)
	const dragBefore = await region
		.locator('.typst-block-drag')
		.getByRole('button', { name: '块操作', exact: true })
		.boundingBox()
	await region.locator('.typst-editor-content').evaluate((el) => {
		el.scrollTop += 24
	})
	await settle()
	const dragAfter = await region
		.locator('.typst-block-drag')
		.getByRole('button', { name: '块操作', exact: true })
		.boundingBox()
	assert.ok(dragBefore && dragAfter && Math.abs(dragBefore.y - dragAfter.y - 24) < 2)
	passed.push(
		'scrolling moves both official and current-block handles with their block and clips an offscreen current block',
	)

	await page.setViewportSize({ width: 360, height: 740 })
	await reset()
	await body.locator(':scope > p').nth(1).tap()
	await page
		.locator('.typst-block-current:visible, .typst-block-drag:visible')
		.getByRole('button', { name: /^(当前块操作|块操作)$/ })
		.tap()
	await menu.waitFor()
	const bounds = await menu.boundingBox()
	assert.ok(
		bounds &&
			bounds.x >= 0 &&
			bounds.x + bounds.width <= 360 &&
			bounds.y >= 0 &&
			bounds.y + bounds.height <= 740,
	)
	await page.screenshot({ path: join(dir, 'mobile-block-actions.png'), fullPage: true })
	await menu.getByRole('button', { name: '下移块', exact: true }).tap()
	assert.deepEqual(await texts(), ['Alpha', 'Charlie', 'Bravo'])
	await undo()
	assert.deepEqual(await snapshot(), fixture)
	passed.push('narrow-screen touch entry and move buttons work without dragging')

	await page.setViewportSize({ width: 1440, height: 1100 })
	await open(1)
	await page.screenshot({ path: join(dir, 'desktop-block-actions.png'), fullPage: true })
	await page.keyboard.press('Escape')
	page.once('dialog', (dialog) => dialog.accept())
	await page.getByRole('combobox', { name: '示例', exact: true }).selectOption('operations-report')
	const templateCard = body.locator('.typst-content-block[data-block-id="channels-primary"]')
	await templateCard.waitFor()
	await hover(1)
	await templateCard.hover()
	await settle()
	assert.equal(
		await templateCard.getByRole('button', { name: '块操作', exact: true }).isVisible(),
		true,
	)
	const figureHandle = region
		.locator('.typst-block-drag')
		.getByRole('button', { name: '块操作', exact: true })
	assert.equal(await figureHandle.isVisible(), true)
	assert.match(await figureHandle.getAttribute('title'), /^图表与题注：/)
	await page
		.getByRole('navigation', { name: '正文区域', exact: true })
		.getByRole('button', { name: '后续行动', exact: true })
		.click()
	const notes = page.getByTestId('region-notes')
	await notes.locator('.tiptap > p').first().hover()
	await notes
		.locator('.typst-block-drag')
		.getByRole('button', { name: '块操作', exact: true })
		.waitFor()
	const sourceCard = notes.locator('.typst-content-block[data-block-id="source-note"]')
	await sourceCard.hover()
	await settle()
	assert.equal(
		await sourceCard.getByRole('button', { name: '块操作', exact: true }).isVisible(),
		true,
	)
	assert.equal(
		await notes
			.locator('.typst-block-drag')
			.getByRole('button', { name: '块操作', exact: true })
			.isVisible(),
		false,
	)
	passed.push(
		'captioned template exposes whole-figure controls; unwrapped source keeps its own controls without a duplicate handle',
	)
	assert.deepEqual(errors, [])
	await writeFile(join(dir, 'result.json'), JSON.stringify({ passed, errors }, null, 2))
	console.log(JSON.stringify({ dir, passed, errors }, null, 2))
} catch (error) {
	await page.screenshot({ path: join(dir, 'failure.png'), fullPage: true })
	await writeFile(
		join(dir, 'failure.json'),
		JSON.stringify(
			{
				error: String(error),
				passed,
				errors,
				html: await body.innerHTML().catch(() => ''),
				text: await page.locator('body').innerText(),
			},
			null,
			2,
		),
	)
	console.error(dir)
	throw error
} finally {
	await page.goto('about:blank')
	await release()
	await browser.close()
}
