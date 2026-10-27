import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { trackConsumerSessions } from './browser-session.mjs'

// Expectations come from native editor conventions, not the implementation's shortcut catalog.
// Reuse the managed app and shared browser; never launch either here.
const output = await mkdtemp(join(tmpdir(), 'typst-shortcuts-'))
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
const panel = page.getByTestId('region-body')
const body = panel.locator('.tiptap')
const toolbar = panel.getByRole('toolbar', { name: '正文格式', exact: true })
const format = page.getByRole('dialog', { name: '文字格式', exact: true })
const link = page.getByRole('dialog', { name: '链接', exact: true })
const snapshot = () => body.evaluate((element) => element.editor.getJSON())
const settled = () =>
	page.evaluate(
		() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
	)
const fixture = {
	type: 'doc',
	content: [
		{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Keyboard text' }] },
		{ type: 'paragraph', content: [{ type: 'text', text: 'List paragraph' }] },
		{
			type: 'blockMath',
			attrs: { latex: 'x^2 + y^2', id: 'shortcut-equation', label: 'eq:shortcuts' },
		},
	],
}
const expected = [
	['加粗', 'Ctrl+B', 'Control+B'],
	['斜体', 'Ctrl+I', 'Control+I'],
	['下划线', 'Ctrl+U', 'Control+U'],
	['列表', 'Ctrl+Shift+8', 'Control+Shift+8'],
	['有序列表', 'Ctrl+Shift+7', 'Control+Shift+7'],
	['链接', 'Ctrl+K', 'Control+K'],
	['清除文字格式', 'Ctrl+\\', 'Control+\\'],
]
async function select(from, to = from) {
	await body.evaluate(
		(element, range) => {
			element.editor.commands.setTextSelection(range)
			element.editor.view.focus()
		},
		{ from, to },
	)
	await settled()
}
async function press(key) {
	await page.keyboard.press(key)
	await settled()
}
async function hints(scope) {
	for (const [label, title, aria] of expected) {
		const button = scope.getByRole('button', { name: label, exact: true })
		const actualTitle = await button.getAttribute('title')
		assert.ok(actualTitle.includes(title), `${label} shows ${title}`)
		assert.equal(await button.getAttribute('aria-keyshortcuts'), aria)
	}
}
async function current() {
	await page
		.getByTestId('revision')
		.filter({ hasText: / · 当前$/ })
		.or(page.getByRole('alert'))
		.first()
		.waitFor({ timeout: 60000 })
	assert.deepEqual(await page.getByRole('alert').allTextContents(), [])
}
async function protectedEvents(locator, composing = false) {
	return locator.evaluate(
		(element, isComposing) =>
			['\\', 'k'].map((key) => {
				const event = new KeyboardEvent('keydown', {
					key,
					code: key === '\\' ? 'Backslash' : 'KeyK',
					ctrlKey: true,
					isComposing,
					bubbles: true,
					cancelable: true,
				})
				element.dispatchEvent(event)
				return { key, prevented: event.defaultPrevented }
			}),
		composing,
	)
}
try {
	await page.addInitScript(() => {
		window.shortcutEvents = []
		window.addEventListener('keydown', (event) =>
			window.shortcutEvents.push({
				key: event.key,
				prevented: event.defaultPrevented,
				target: event.target.tagName,
			}),
		)
	})
	const url = new URL(process.env.PLUXEL_TYPST_URL ?? 'http://typst.pluxel.localhost:8088')
	url.searchParams.set('example', 'consumer-report')
	await page.goto(url.href)
	await current()
	assert.match(
		await page.evaluate(() => navigator.platform),
		/Linux/,
		'physical shortcut checks run in the Linux browser',
	)
	await body.evaluate((element, content) => element.editor.commands.setContent(content), fixture)
	await current()
	const original = await snapshot()
	await hints(toolbar)
	assert.equal(
		await toolbar
			.getByRole('button', { name: '撤销', exact: true })
			.getAttribute('aria-keyshortcuts'),
		'Control+Z',
	)
	assert.equal(
		await toolbar
			.getByRole('button', { name: '重做', exact: true })
			.getAttribute('aria-keyshortcuts'),
		'Control+Shift+Z Control+Y',
	)
	const redoTitle = await toolbar
		.getByRole('button', { name: '重做', exact: true })
		.getAttribute('title')
	assert.ok(redoTitle.includes('Ctrl+Shift+Z / Ctrl+Y'))
	for (const [key, mark] of [
		['Control+b', 'bold'],
		['Control+i', 'italic'],
		['Control+u', 'underline'],
	]) {
		await select(1, 9)
		await press(key)
		const changed = await snapshot()
		assert.equal(changed.content[0].content[0].text, 'Keyboard')
		assert.ok(changed.content[0].content[0].marks.some((item) => item.type === mark))
		await press('Control+z')
		assert.deepEqual(await snapshot(), original)
		if (mark === 'bold') {
			for (const redo of ['Control+Shift+z', 'Control+y']) {
				await press(redo)
				assert.deepEqual(await snapshot(), changed)
				await press('Control+z')
				assert.deepEqual(await snapshot(), original)
			}
		}
	}
	for (const [key, type] of [
		['Control+Shift+8', 'bulletList'],
		['Control+Shift+7', 'orderedList'],
	]) {
		const at = await body.evaluate((element) => element.editor.state.doc.firstChild.nodeSize + 1)
		await select(at)
		await press(key)
		const listed = await snapshot()
		assert.equal(listed.content[1].type, type)
		await press('Control+z')
		assert.deepEqual(await snapshot(), original)
	}
	await select(1, 9)
	await press('Control+Shift+e')
	const aligned = await snapshot()
	assert.equal(aligned.content[0].attrs.textAlign, 'center')
	const alignmentTitle = await toolbar
		.locator('select[aria-label="段落对齐"] option[value="center"]')
		.getAttribute('title')
	assert.ok(alignmentTitle.includes('Ctrl+Shift+E'))
	await press('Control+z')
	assert.deepEqual(await snapshot(), original)
	checks.push(
		'Linux native marks, both redo alternatives, lists, alignment and undo match their advertised shortcuts',
	)

	await select(1, 9)
	await press('Control+k')
	await link.waitFor()
	const address = link.getByRole('textbox', { name: '链接地址', exact: true })
	await address.fill('https://example.com/keyboard')
	assert.equal(
		await link
			.getByRole('button', { name: '应用链接', exact: true })
			.getAttribute('aria-keyshortcuts'),
		'Enter',
	)
	await address.press('Enter')
	await settled()
	assert.deepEqual(await link.getByRole('alert').allTextContents(), [])
	await link.waitFor({ state: 'hidden' })
	assert.equal(await body.locator('h2 a').getAttribute('href'), 'https://example.com/keyboard')
	await press('Control+z')
	assert.deepEqual(await snapshot(), original)
	await select(1, 9)
	await press('Shift+F10')
	await format.waitFor()
	await hints(format)
	assert.equal(
		await toolbar
			.getByRole('button', { name: '格式', exact: true })
			.getAttribute('aria-keyshortcuts'),
		'Shift+F10 ContextMenu',
	)
	assert.equal(
		await format
			.getByRole('button', { name: '关闭格式', exact: true })
			.getAttribute('aria-keyshortcuts'),
		'Escape',
	)
	await page.screenshot({ path: join(output, 'desktop-format.png'), fullPage: true })
	await press('Escape')
	await select(2)
	await press('Alt+F10')
	const block = page.getByRole('button', { name: '当前块操作', exact: true })
	assert.equal(await block.evaluate((element) => element === document.activeElement), true)
	assert.equal(await block.getAttribute('aria-keyshortcuts'), 'Alt+F10')
	const blockTitle = await block.getAttribute('title')
	assert.ok(blockTitle.includes('Alt+F10'))
	await press('Enter')
	await page.getByRole('dialog', { name: '块操作', exact: true }).waitFor()
	await page.screenshot({ path: join(output, 'desktop-block.png'), fullPage: true })
	await press('Escape')
	checks.push('Ctrl+K, Shift+F10 and Alt+F10 open the promised link, format and block controls')

	const styledFixture = structuredClone(fixture)
	styledFixture.content[0].attrs.textAlign = 'right'
	styledFixture.content[0].content[0].marks = [
		{ type: 'bold' },
		{ type: 'italic' },
		{ type: 'underline' },
		{ type: 'link', attrs: { href: 'https://example.com/styled' } },
		{
			type: 'textStyle',
			attrs: {
				fontFamily: 'Liberation Serif',
				fontSize: '18pt',
				color: '#8a4a16',
				backgroundColor: '#fff0c2',
			},
		},
	]
	await body.evaluate(
		(element, content) => element.editor.commands.setContent(content),
		styledFixture,
	)
	await current()
	const styled = await snapshot()
	await select(1, 14)
	await press('Control+Backslash')
	const cleared = await snapshot()
	assert.equal(cleared.content[0].type, 'heading')
	assert.deepEqual(cleared.content[0].attrs, styled.content[0].attrs)
	assert.equal(cleared.content[0].content[0].text, 'Keyboard text')
	assert.ok(cleared.content[0].content.every((node) => !node.marks?.length))
	assert.deepEqual(cleared.content.slice(1), styled.content.slice(1))
	await press('Control+z')
	assert.deepEqual(await snapshot(), styled)
	await select(5)
	await press('Control+Backslash')
	assert.deepEqual(
		await snapshot(),
		styled,
		'clearing stored marks at a caret does not alter existing text',
	)
	await page.keyboard.insertText('X')
	const typed = await snapshot()
	const inserted = typed.content[0].content.find((node) => node.text === 'X')
	assert.ok(inserted)
	assert.ok(!inserted.marks?.length, 'new text does not inherit the old marks')
	await press('Control+z')
	assert.deepEqual(await snapshot(), styled)
	checks.push(
		'Ctrl+Backslash clears selected marks once, preserves heading/alignment/content, and resets future typing marks',
	)

	// Native fields must retain keyboard ownership even with an active formatted selection.
	const equation = body.locator('[data-equation-id="shortcut-equation"]')
	const label = equation.getByRole('textbox', { name: '公式引用 label', exact: true })
	await select(1, 9)
	await label.focus()
	await page.evaluate(() => {
		window.shortcutEvents = []
	})
	for (const key of ['Control+Backslash', 'Control+k']) await label.press(key)
	assert.equal(await label.inputValue(), 'eq:shortcuts')
	assert.deepEqual(await snapshot(), styled)
	assert.equal(await link.isVisible(), false)
	const labelEvents = await page.evaluate(() =>
		window.shortcutEvents.filter((event) => event.key === '\\' || event.key.toLowerCase() === 'k'),
	)
	assert.deepEqual(
		labelEvents.map((event) => event.prevented),
		[false, false],
	)
	await equation.getByRole('button', { name: '编辑独立公式', exact: true }).click()
	const latex = equation.getByRole('textbox', { name: '公式 LaTeX', exact: true })
	await latex.waitFor()
	await page.evaluate(() => {
		window.shortcutEvents = []
	})
	for (const key of ['Control+Backslash', 'Control+k']) await latex.press(key)
	assert.equal(await latex.inputValue(), 'x^2 + y^2')
	assert.deepEqual(await snapshot(), styled)
	assert.equal(await link.isVisible(), false)
	const latexEvents = await page.evaluate(() =>
		window.shortcutEvents.filter((event) => event.key === '\\' || event.key.toLowerCase() === 'k'),
	)
	assert.deepEqual(
		latexEvents.map((event) => event.prevented),
		[false, false],
	)
	assert.equal(
		await equation
			.getByRole('button', { name: '完成', exact: true })
			.getAttribute('aria-keyshortcuts'),
		'Control+Enter',
	)
	assert.equal(
		await equation
			.getByRole('button', { name: '取消', exact: true })
			.getAttribute('aria-keyshortcuts'),
		'Escape',
	)
	await latex.press('Escape')
	await page.getByRole('checkbox', { name: '区域只读', exact: true }).check()
	const readOnlyEvents = await protectedEvents(body)
	assert.ok(readOnlyEvents.every((event) => !event.prevented))
	assert.deepEqual(await snapshot(), styled)
	assert.equal(await link.isVisible(), false)
	await page.getByRole('checkbox', { name: '区域只读', exact: true }).uncheck()
	await select(1, 9)
	await body.dispatchEvent('compositionstart', { data: '中' })
	const compositionEvents = await protectedEvents(body, true)
	assert.ok(compositionEvents.every((event) => !event.prevented))
	assert.deepEqual(await snapshot(), styled)
	assert.equal(await link.isVisible(), false)
	await body.dispatchEvent('compositionend', { data: '中' })
	await page.waitForFunction(
		() => !document.querySelector('[data-testid="region-body"] .tiptap').editor.view.composing,
	)
	checks.push(
		'native input/LaTeX keys are not prevented; readonly and synthetic IME events cannot clear marks or open links',
	)

	await page.setViewportSize({ width: 390, height: 844 })
	await select(1, 9)
	await press('Shift+F10')
	await format.waitFor()
	const bounds = await format.boundingBox()
	assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390)
	assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
	await page.screenshot({ path: join(output, 'mobile-format.png'), fullPage: true })
	await press('Escape')
	await current()

	// This checks only macOS presentation under a simulated platform, not OS keyboard behavior.
	const mac = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
	const macPage = await mac.newPage()
	const releaseMac = trackConsumerSessions(macPage)
	macPage.on('pageerror', (error) => errors.push(String(error)))
	try {
		await macPage.addInitScript(() =>
			Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' }),
		)
		await macPage.goto(url.href)
		await macPage
			.getByTestId('revision')
			.filter({ hasText: / · 当前$/ })
			.waitFor({ timeout: 60000 })
		const macToolbar = macPage
			.getByTestId('region-body')
			.getByRole('toolbar', { name: '正文格式', exact: true })
		for (const [name, title, aria] of [
			['加粗', '⌘B', 'Meta+B'],
			['重做', '⇧⌘Z / ⌘Y', 'Meta+Shift+Z Meta+Y'],
			['格式', '⇧F10', 'Shift+F10 ContextMenu'],
		]) {
			const control = macToolbar.getByRole('button', { name, exact: true })
			const actualTitle = await control.getAttribute('title')
			assert.ok(actualTitle.includes(title))
			assert.equal(await control.getAttribute('aria-keyshortcuts'), aria)
		}
		const macHeadingTitle = await macToolbar
			.locator('select[aria-label="段落样式"] option[value="heading-1"]')
			.getAttribute('title')
		assert.ok(macHeadingTitle.includes('⌥⌘1'))
		checks.push('simulated Mac platform presents ⌘, ⇧ and ⌥ consistently; no macOS hardware claim')
	} finally {
		await releaseMac()
		await mac.close()
	}
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
