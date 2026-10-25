import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { trackConsumerSessions } from './browser-session.mjs'

const output =
	process.env.PLUXEL_TYPST_INSERTION_OUTPUT ??
	(await mkdtemp(join(tmpdir(), 'typst-insertion-ui-')))
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, hasTouch: true })
const releaseSessions = trackConsumerSessions(page)
const errors = []
page.on('dialog', (dialog) => dialog.accept())
page.on('pageerror', (error) => errors.push(String(error)))
const region = page.getByTestId('region-notes')
const editor = region.locator('.tiptap')
const trigger = region.getByRole('button', { name: '插入', exact: true })
const menu = page.getByRole('dialog', { name: '插入内容', exact: true })
const search = menu.getByRole('searchbox', { name: '搜索插入内容', exact: true })
const list = page.getByRole('listbox', { name: '插入内容', exact: true })
const snapshot = () => editor.evaluate((element) => element.editor.getJSON())
const selection = () => editor.evaluate((element) => element.editor.state.selection.toJSON())
const undo = () => region.getByRole('button', { name: '撤销', exact: true }).click()
const redo = () => region.getByRole('button', { name: '重做', exact: true }).click()
const option = (name) => list.getByRole('option', { name, exact: true })
async function current() {
	await page
		.getByTestId('revision')
		.filter({ hasText: / · 当前$/ })
		.waitFor({ timeout: 60000 })
	assert.equal(await page.getByRole('alert').count(), 0)
}
async function caretAtEnd() {
	await editor.evaluate((element) => {
		const native = element.editor
		let at
		native.state.doc.forEach((node, pos) => {
			if (node.isTextblock) at = pos + node.nodeSize - 1
		})
		if (at === undefined) throw new Error('Expected an editable text block')
		native.commands.setTextSelection(at)
		native.view.focus()
	})
	await page.evaluate(
		() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
	)
}
async function showRegion(name) {
	await page
		.getByRole('navigation', { name: '正文区域', exact: true })
		.getByRole('button', { name, exact: true })
		.click()
	await caretAtEnd()
}
async function searchFor(query) {
	await trigger.click()
	await menu.waitFor()
	await search.fill(query)
}
async function titles() {
	return list
		.getByRole('option')
		.evaluateAll((items) => items.map((item) => item.getAttribute('aria-label')))
}
try {
	await page.goto(process.env.PLUXEL_TYPST_URL ?? 'http://typst.pluxel.localhost:8088')
	await current()
	await showRegion('备注')
	const original = await snapshot()
	const originalSelection = await selection()
	await trigger.click()
	await menu.waitFor()
	const baseTitles = await titles()
	assert.ok(baseTitles.includes('客户名称'))
	assert.ok(baseTitles.includes('提示块'))
	assert.equal(
		baseTitles.includes('Typst 源码块'),
		false,
		'Source insertion requires explicit installation',
	)
	assert.deepEqual(
		await snapshot(),
		original,
		'Opening and probing actions does not edit the document',
	)
	assert.deepEqual(
		await selection(),
		originalSelection,
		'Search focus retains the native selection',
	)
	await page.screenshot({ path: join(output, 'insert-menu-desktop.png') })
	await search.press('Escape')
	await menu.waitFor({ state: 'hidden' })
	assert.equal(await trigger.evaluate((element) => element === document.activeElement), true)
	await trigger.press('ArrowDown')
	await search.waitFor()
	await search.fill('customer')
	assert.deepEqual(await titles(), ['客户名称'])
	await search.press('Enter')
	await menu.waitFor({ state: 'hidden' })
	assert.equal(await editor.locator('[data-data-field]').count(), 1)
	const withField = await snapshot()
	await current()
	await undo()
	assert.deepEqual(await snapshot(), original, 'One undo removes button insertion')
	await redo()
	assert.deepEqual(await snapshot(), withField)
	await undo()
	await caretAtEnd()
	await editor.press('Enter')
	await page.keyboard.insertText('/')
	await list.waitFor()
	assert.deepEqual(await titles(), baseTitles, 'Button and slash list the same available actions')
	await page.keyboard.insertText('notice')
	assert.deepEqual(await titles(), ['提示块'])
	const withQuery = await snapshot()
	await editor.press('Enter')
	await list.waitFor({ state: 'hidden' })
	assert.match(await editor.innerText(), /Consumer-owned notice/)
	assert.doesNotMatch(await editor.innerText(), /\/notice/)
	const withNotice = await snapshot()
	await current()
	await undo()
	assert.deepEqual(await snapshot(), withQuery, 'One undo restores the complete slash query')
	await redo()
	assert.deepEqual(await snapshot(), withNotice)
	await page.getByRole('combobox', { name: '示例', exact: true }).selectOption('operations-report')
	await current()
	await showRegion('后续行动')
	const reportNotes = await snapshot()
	const reportFields = await editor.locator('[data-data-field]').count()
	await searchFor('渠道')
	assert.deepEqual(await titles(), ['渠道收入与目标'])
	await option('渠道收入与目标').click()
	await current()
	const withTemplate = await snapshot()
	const template = withTemplate.content.find((node) => node.type === 'templateBlock')
	assert.equal(template.attrs.template, 'channels')
	assert.deepEqual(template.attrs.props, { title: '渠道收入与目标' })
	assert.deepEqual(template.attrs.dataPath, [])
	await undo()
	assert.deepEqual(await snapshot(), reportNotes)
	await redo()
	assert.deepEqual(await snapshot(), withTemplate, 'Redo preserves the created instance identity')
	await undo()
	await caretAtEnd()
	await searchFor('Typst')
	await option('Typst 源码块').click()
	await current()
	const withSource = await snapshot()
	const source = withSource.content.find(
		(node) => node.type === 'typstSource' && node.attrs.id !== 'source-note',
	)
	assert.equal(source.attrs.source, '', 'The SDK does not insert host-specific sample source')
	const card = editor.locator(`[data-block-id="${source.attrs.id}"]`)
	await card.locator('summary').click()
	const sourceInput = card.getByRole('textbox', { name: '组件 Typst 源码', exact: true })
	await sourceInput.fill('#text[Inserted source text]')
	await card.getByRole('button', { name: '应用组件修改', exact: true }).click()
	await current()
	const editedSource = await snapshot()
	assert.equal(
		editedSource.content.find((node) => node.attrs?.id === source.attrs.id).attrs.source,
		'#text[Inserted source text]',
	)
	await undo()
	assert.deepEqual(await snapshot(), withSource, 'Editing source has its own transaction')
	await undo()
	assert.deepEqual(await snapshot(), reportNotes, 'Inserting source has one undo boundary')
	await caretAtEnd()
	const beforeRestricted = await snapshot()
	await page.getByRole('checkbox', { name: '区域只读', exact: true }).check()
	assert.equal(await trigger.isDisabled(), true)
	assert.equal(await menu.isVisible(), false)
	await page.getByRole('checkbox', { name: '区域只读', exact: true }).uncheck()
	await editor.dispatchEvent('compositionstart', { data: '' })
	assert.equal(await trigger.isDisabled(), true)
	assert.equal(
		await editor.evaluate((element) => {
			const event = new KeyboardEvent('keydown', {
				key: 'Enter',
				isComposing: true,
				bubbles: true,
				cancelable: true,
			})
			element.dispatchEvent(event)
			return event.defaultPrevented
		}),
		false,
		'Insertion keyboard handling leaves IME confirmation native',
	)
	assert.deepEqual(await snapshot(), beforeRestricted)
	await editor.dispatchEvent('compositionend', { data: '' })
	await page.setViewportSize({ width: 320, height: 740 })
	await trigger.scrollIntoViewIfNeeded()
	await trigger.tap()
	await menu.waitFor()
	const bounds = await menu.boundingBox()
	assert.ok(
		bounds &&
			bounds.x >= 0 &&
			bounds.y >= 0 &&
			bounds.x + bounds.width <= 320 &&
			bounds.y + bounds.height <= 740,
	)
	await search.fill('公司')
	await option('公司名称').waitFor()
	await page.screenshot({ path: join(output, 'insert-menu-mobile.png') })
	await option('公司名称').tap()
	await current()
	assert.equal(await editor.locator('[data-data-field]').count(), reportFields + 1)
	await undo()
	assert.deepEqual(await snapshot(), reportNotes, 'Touch insertion uses the same native history')
	assert.deepEqual(errors, [])
	const result = {
		output,
		checks: [
			'shared-directory',
			'search-keyboard-escape',
			'field',
			'custom-notice',
			'template',
			'empty-source-edit',
			'undo-redo',
			'readonly-ime',
			'320px-touch',
		],
		pageErrors: errors,
	}
	await writeFile(join(output, 'result.json'), JSON.stringify(result, null, 2))
	console.log(JSON.stringify(result, null, 2))
} catch (error) {
	await page.screenshot({ path: join(output, 'failure.png'), fullPage: true })
	await writeFile(join(output, 'failure.html'), await page.content())
	await writeFile(
		join(output, 'failure.json'),
		JSON.stringify({ error: String(error), pageErrors: errors }, null, 2),
	)
	throw error
} finally {
	try {
		await page.goto('about:blank')
		await releaseSessions()
	} finally {
		await browser.close()
	}
}
