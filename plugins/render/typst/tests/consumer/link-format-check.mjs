import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { trackConsumerSessions } from './browser-session.mjs'

const dir = await mkdtemp(join(tmpdir(), 'typst-link-format-'))
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } })
const release = trackConsumerSessions(page)
const errors = []
const failedResponses = []
const consoleErrors = []
const passed = []
page.on('pageerror', (error) => errors.push(String(error)))
page.on('response', (response) => {
	if (response.status() >= 400)
		failedResponses.push({ url: response.url(), status: response.status() })
})
page.on('console', (message) => {
	if (message.type() === 'error') consoleErrors.push(message.text())
})
const body = page.getByTestId('region-body').locator('.tiptap')
const toolbar = page
	.getByTestId('region-body')
	.getByRole('toolbar', { name: '正文格式', exact: true })
const format = page.getByRole('dialog', { name: '文字格式', exact: true })
const link = page.getByRole('dialog', { name: '链接', exact: true })
const address = link.getByRole('textbox', { name: '链接地址', exact: true })
const apply = link.getByRole('button', { name: '应用链接', exact: true })
const snapshot = () => body.evaluate((el) => el.editor.getJSON())
const nativeSelection = () => body.evaluate((el) => el.editor.state.selection.toJSON())
async function settle() {
	await page.evaluate(
		() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
	)
}
async function select(from, to = from) {
	await body.evaluate(
		(el, range) => {
			el.editor.commands.setTextSelection(range)
			el.editor.view.focus()
		},
		{ from, to },
	)
	await settle()
}
async function openLink() {
	await page.keyboard.press('ControlOrMeta+k')
	await link.waitFor()
	await address.waitFor()
	await settle()
}
async function undo() {
	await toolbar.getByRole('button', { name: '撤销', exact: true }).click()
	await settle()
}
async function openFormat() {
	await toolbar.getByRole('button', { name: '格式', exact: true }).click()
	await format.waitFor()
}
try {
	const url = new URL(process.env.PLUXEL_TYPST_URL ?? 'http://typst.pluxel.localhost:8088')
	url.searchParams.set('example', 'consumer-report')
	await page.goto(url.href)
	await page
		.getByTestId('revision')
		.filter({ hasText: / · 当前$/ })
		.waitFor({ timeout: 60000 })
	const from = await body.evaluate((el) => {
		let found
		el.editor.state.doc.descendants((node, position) => {
			if (found === undefined && node.isText && node.text.includes('Editable'))
				found = position + node.text.indexOf('Editable')
		})
		return found
	})
	assert.equal(typeof from, 'number')
	const to = from + 8
	const original = await snapshot()
	const href = 'https://example.com/typst-editor-review'
	await select(from, to)
	await openLink()
	assert.equal(await address.evaluate((el) => el === document.activeElement), true)
	assert.equal(await body.evaluate((el) => el.editor.view.hasFocus()), false)
	assert.deepEqual(await nativeSelection(), { type: 'text', anchor: from, head: to })
	await apply.click()
	assert.match(await link.getByRole('alert').innerText(), /请输入/)
	assert.deepEqual(await snapshot(), original)
	for (const unsafe of [
		'javascript:alert(1)',
		'data:text/html,unsafe',
		'https://example.com/a b',
	]) {
		await address.fill(unsafe)
		await apply.click()
		assert.equal(await link.getByRole('alert').isVisible(), true)
		assert.equal(await link.getByRole('link', { name: '打开链接', exact: true }).count(), 0)
		assert.deepEqual(await snapshot(), original)
	}
	await address.fill(href)
	const open = link.getByRole('link', { name: '打开链接', exact: true })
	assert.equal(await open.getAttribute('href'), href)
	assert.equal(await open.getAttribute('target'), '_blank')
	assert.equal(await open.getAttribute('rel'), 'noopener noreferrer')
	await apply.click()
	assert.equal(await link.isVisible(), false)
	assert.equal(await body.locator('h2 a').innerText(), 'Editable')
	assert.equal(await body.locator('h2 a').getAttribute('href'), href)
	assert.deepEqual(await nativeSelection(), { type: 'text', anchor: from, head: to })
	const linked = await snapshot()
	await page
		.getByTestId('revision')
		.filter({ hasText: / · 当前$/ })
		.waitFor({ timeout: 60000 })
	const download = page.waitForEvent('download')
	await page.getByRole('button', { name: '导出当前 PDF', exact: true }).click()
	const exported = await download
	await exported.saveAs(join(dir, 'linked.pdf'))
	const pdf = await readFile(join(dir, 'linked.pdf'))
	assert.equal(pdf.subarray(0, 5).toString(), '%PDF-')
	assert.ok(pdf.length > 1000)
	await undo()
	assert.deepEqual(await snapshot(), original)
	await toolbar.getByRole('button', { name: '重做', exact: true }).click()
	assert.deepEqual(await snapshot(), linked)
	passed.push(
		'Mod+K preserves native selection through input focus; invalid URLs fail visibly, safe links serialize to real PDF and undo/redo once',
	)

	await select(from + 3)
	await openFormat()
	await format.getByRole('button', { name: '链接', exact: true }).click()
	await link.waitFor()
	assert.equal(await address.inputValue(), href)
	assert.equal(await link.getByRole('textbox', { name: '链接文字', exact: true }).count(), 0)
	await address.fill('https://example.com/updated')
	await apply.click()
	assert.equal(await body.locator('h2 a').innerText(), 'Editable')
	assert.equal(await body.locator('h2 a').getAttribute('href'), 'https://example.com/updated')
	const updated = await snapshot()
	await select(from + 2)
	await openLink()
	await link.getByRole('button', { name: '移除链接', exact: true }).click()
	assert.deepEqual(await snapshot(), original)
	await undo()
	assert.deepEqual(await snapshot(), updated)
	await undo()
	assert.deepEqual(await snapshot(), linked)
	await undo()
	assert.deepEqual(await snapshot(), original)
	passed.push(
		'format link entry edits the entire existing link from a caret; removal and each edit remain independently undoable',
	)

	await select(to)
	await openLink()
	await address.fill(href)
	const label = link.getByRole('textbox', { name: '链接文字', exact: true })
	await label.focus()
	const cdp = await page.context().newCDPSession(page)
	await cdp.send('Input.imeSetComposition', {
		text: '链接文字',
		selectionStart: 4,
		selectionEnd: 4,
	})
	await settle()
	assert.equal(await link.isVisible(), true)
	assert.equal(await apply.isDisabled(), true)
	assert.equal(
		await label.evaluate((el) => {
			const event = new KeyboardEvent('keydown', {
				key: 'Enter',
				code: 'Enter',
				bubbles: true,
				cancelable: true,
				isComposing: true,
			})
			el.dispatchEvent(event)
			return event.defaultPrevented
		}),
		true,
	)
	assert.deepEqual(await snapshot(), original)
	await cdp.send('Input.insertText', { text: '链接文字' })
	await settle()
	assert.equal(await apply.isEnabled(), true)
	await apply.click()
	assert.equal(await body.locator('h2 a').innerText(), '链接文字')
	assert.equal(await body.locator('h2').innerText(), 'Editable链接文字 overview')
	await page.keyboard.insertText('X')
	assert.equal(await body.locator('h2 a').innerText(), '链接文字')
	await undo()
	// Typing may share the native insertion event; always check the exact result before further undo.
	const afterTypingUndo = await body.locator('h2').innerText()
	assert.equal(afterTypingUndo, 'Editable overview')
	assert.deepEqual(await snapshot(), original)
	await cdp.detach()
	await select(to)
	await openLink()
	await address.fill(href)
	await apply.click()
	assert.equal(await body.locator('h2 a').innerText(), href)
	await undo()
	assert.deepEqual(await snapshot(), original)
	passed.push(
		'empty caret inserts custom or URL text; real Chromium composition stays inside the link form and Enter cannot submit early',
	)

	await select(from, to)
	await openLink()
	await address.fill(href)
	await apply.click()
	await openFormat()
	await format.getByRole('button', { name: '加粗', exact: true }).click()
	await format.getByRole('combobox', { name: '字号', exact: true }).selectOption('18pt')
	const styled = await snapshot()
	await format.getByRole('button', { name: '清除文字格式', exact: true }).click()
	assert.deepEqual(await snapshot(), original)
	await undo()
	assert.deepEqual(await snapshot(), styled)
	await undo()
	await undo()
	await undo()
	assert.deepEqual(await snapshot(), original)
	await select(to)
	await openFormat()
	await format.getByRole('button', { name: '加粗', exact: true }).click()
	await format.getByRole('button', { name: '清除文字格式', exact: true }).click()
	await page.keyboard.press('Escape')
	await page.keyboard.insertText('X')
	assert.equal(await body.locator('h2 strong').count(), 0)
	await undo()
	assert.deepEqual(await snapshot(), original)
	passed.push(
		'clear text format removes link, basic marks and typography with undo, and clears caret typing marks',
	)

	await body.evaluate((el) =>
		el.editor.commands.insertContentAt(el.editor.state.doc.content.size, {
			type: 'bulletList',
			content: ['First link format item', 'Second link format item'].map((text) => ({
				type: 'listItem',
				content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
			})),
		}),
	)
	const listBaseline = await snapshot()
	const listPosition = await body.evaluate((el) => {
		let found
		el.editor.state.doc.descendants((node, position) => {
			if (node.isText && node.text === 'Second link format item') found = position
		})
		return found
	})
	await select(listPosition + 1)
	await openFormat()
	await format.getByRole('button', { name: '增加缩进', exact: true }).click()
	assert.equal(await body.locator('ul ul').innerText(), 'Second link format item')
	const indented = await snapshot()
	await format.getByRole('button', { name: '减少缩进', exact: true }).click()
	assert.deepEqual(await snapshot(), listBaseline)
	await undo()
	assert.deepEqual(await snapshot(), indented)
	await undo()
	assert.deepEqual(await snapshot(), listBaseline)
	await undo()
	assert.deepEqual(await snapshot(), original)
	passed.push('list indent/outdent use native list structure and each action has one undo')

	await select(from, to)
	await openLink()
	await body.dispatchEvent('compositionstart', { data: '拼' })
	await settle()
	assert.equal(await link.isVisible(), false)
	await body.dispatchEvent('compositionend', { data: '拼' })
	await settle()
	await page.getByRole('checkbox', { name: '区域只读', exact: true }).check()
	await body.focus()
	await page.keyboard.press('ControlOrMeta+k')
	assert.equal(await link.isVisible(), false)
	assert.deepEqual(await snapshot(), original)
	await page.getByRole('checkbox', { name: '区域只读', exact: true }).uncheck()
	await select(from, to)
	await openLink()
	await address.fill('https://example.com/stale')
	await select(to + 1)
	assert.equal(await link.isVisible(), false)
	assert.deepEqual(await snapshot(), original)
	passed.push(
		'readonly and editor composition prevent editing; external native selection changes discard the link draft',
	)
	await select(from, to)
	await openLink()
	await address.fill('https://example.com/hidden')
	await page.getByTestId('region-body').evaluate((element) => {
		element.hidden = true
	})
	await link.waitFor({ state: 'hidden' })
	await page.getByTestId('region-body').evaluate((element) => {
		element.hidden = false
	})
	await settle()
	assert.deepEqual(await snapshot(), original)
	passed.push(
		'programmatically hiding the owning region closes its portal without focus or document changes',
	)

	await page.setViewportSize({ width: 360, height: 800 })
	await select(from, to)
	await openFormat()
	await format.getByRole('button', { name: '链接', exact: true }).click()
	await link.waitFor()
	await address.fill(href)
	for (const target of [
		link,
		address,
		apply,
		link.getByRole('link', { name: '打开链接', exact: true }),
	]) {
		const rect = await target.boundingBox()
		assert.ok(rect && rect.x >= 0 && rect.x + rect.width <= 361)
	}
	await page.screenshot({ path: join(dir, 'link-mobile.png'), fullPage: true })
	await link.getByRole('button', { name: '返回格式', exact: true }).click()
	await format.waitFor()
	await page.keyboard.press('Escape')
	assert.deepEqual(await snapshot(), original)
	passed.push('touch-visible format entry, link input and safe-open action fit a 360px viewport')
	assert.deepEqual(errors, [])
	await writeFile(
		join(dir, 'summary.json'),
		JSON.stringify({ passed, pageErrors: errors, evidence: dir }, null, 2),
	)
	console.log(JSON.stringify({ passed, pageErrors: errors, evidence: dir }, null, 2))
} catch (error) {
	await page.screenshot({ path: join(dir, 'failure.png'), fullPage: true }).catch(() => {})
	await writeFile(
		join(dir, 'failure.json'),
		JSON.stringify(
			{
				passed,
				pageErrors: errors,
				failedResponses,
				consoleErrors,
				error: String(error),
				stack: error.stack,
			},
			null,
			2,
		),
	)
	console.error(`Evidence: ${dir}`)
	throw error
} finally {
	await page.goto('about:blank').catch(() => {})
	await release()
	await browser.close()
}
