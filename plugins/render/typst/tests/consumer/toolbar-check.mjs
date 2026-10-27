import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { trackConsumerSessions } from './browser-session.mjs'

const dir = await mkdtemp(join(tmpdir(), 'typst-toolbar-ui-'))
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } })
const release = trackConsumerSessions(page)
const errors = []
const failedResponses = []
const passed = []
page.on('pageerror', (error) => errors.push(String(error)))
page.on('response', (response) => {
	if (response.status() >= 400)
		failedResponses.push({ url: response.url(), status: response.status() })
})
const region = page.getByTestId('region-body')
const body = region.locator('.tiptap')
const toolbar = region.getByRole('toolbar', { name: '正文格式', exact: true })
const font = toolbar.getByRole('combobox', { name: '字体', exact: true })
const size = toolbar.getByRole('combobox', { name: '字号', exact: true })
const alignment = toolbar.getByRole('combobox', { name: '段落对齐', exact: true })
const format = page.getByRole('dialog', { name: '文字格式', exact: true })
const snapshot = () => body.evaluate((el) => el.editor.getJSON())
const selection = () => body.evaluate((el) => el.editor.state.selection.toJSON())
const active = (locator) => locator.evaluate((el) => el === el.ownerDocument.activeElement)
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
async function undo() {
	await toolbar.getByRole('button', { name: '撤销', exact: true }).click()
	await settle()
}
async function chooseColor(label, name) {
	await toolbar.getByRole('button', { name: label, exact: true }).click()
	const palette = page.getByRole('dialog', { name: label, exact: true })
	await palette.waitFor()
	await palette.getByRole('button', { name, exact: true }).click()
	await settle()
	assert.equal(await palette.isVisible(), false)
	assert.equal(await body.evaluate((el) => el.editor.view.hasFocus()), true)
}
async function currentPreview() {
	await settle()
	await page
		.getByTestId('revision')
		.filter({ hasText: / · 当前$/ })
		.waitFor({ timeout: 60000 })
}
try {
	const url = new URL(process.env.PLUXEL_TYPST_URL ?? 'http://typst.pluxel.localhost:8088')
	url.searchParams.set('example', 'consumer-report')
	await page.goto(url.href)
	await currentPreview()
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
	await select(from, to)
	const target = await selection()
	const history = [original]
	await font.focus()
	await font.selectOption('Noto Serif CJK SC')
	assert.equal(await active(font), true)
	await currentPreview()
	history.push(await snapshot())
	await size.focus()
	await size.selectOption('18pt')
	assert.equal(await active(size), true)
	await currentPreview()
	history.push(await snapshot())
	await chooseColor('文字颜色', '蓝色')
	await currentPreview()
	history.push(await snapshot())
	await chooseColor('背景颜色', '黄色')
	await currentPreview()
	history.push(await snapshot())
	await alignment.selectOption('center')
	await currentPreview()
	const centered = await snapshot()
	assert.equal(centered.content[0].attrs.textAlign, 'center')
	assert.deepEqual(await selection(), target)
	assert.equal(await format.isVisible(), false)
	const styled = await snapshot()
	await toolbar.getByRole('button', { name: '清除文字格式', exact: true }).click()
	await currentPreview()
	const cleared = await snapshot()
	assert.equal(cleared.content[0].attrs.textAlign, 'center')
	assert.equal(cleared.content[0].type, 'heading')
	assert.equal(
		cleared.content[0].content.some((node) => node.marks?.length),
		false,
	)
	await undo()
	assert.deepEqual(await snapshot(), styled)
	for (let i = history.length - 1; i >= 0; i--) {
		await undo()
		assert.deepEqual(await snapshot(), history[i])
	}
	passed.push(
		'permanent font/size/colors/alignment preserve the native target and each undo; clear text marks retains heading and alignment',
	)

	await select(from, from + 4)
	await font.selectOption('Liberation Serif')
	await size.selectOption('18pt')
	await chooseColor('文字颜色', '蓝色')
	await chooseColor('背景颜色', '黄色')
	await select(from, to)
	assert.equal(await font.inputValue(), '__mixed__')
	assert.equal(await size.inputValue(), '__mixed__')
	for (const name of ['文字颜色', '背景颜色'])
		assert.match(
			await toolbar.getByRole('button', { name, exact: true }).getAttribute('title'),
			/混合/,
		)
	await alignment.selectOption('center')
	const secondParagraph = await body.evaluate((el) => el.editor.state.doc.firstChild.nodeSize + 1)
	await select(from, secondParagraph + 3)
	assert.equal(await alignment.inputValue(), '__mixed__')
	await page.screenshot({ path: join(dir, 'mixed-toolbar.png'), fullPage: true })
	for (let i = 0; i < 5; i++) await undo()
	assert.deepEqual(await snapshot(), original)
	passed.push(
		'mixed font, size, foreground, highlight and paragraph alignment are explicit across native selections',
	)

	const paragraphStyle = toolbar.getByRole('combobox', { name: '段落样式', exact: true })
	for (const firstType of ['heading', 'paragraph']) {
		const first = {
			type: firstType,
			...(firstType === 'heading' ? { attrs: { level: 1 } } : {}),
			content: [{ type: 'text', text: 'Toolbar mixed first' }],
		}
		const second = {
			type: 'heading',
			attrs: { level: 2 },
			content: [{ type: 'text', text: 'Toolbar mixed second' }],
		}
		await body.evaluate(
			(el, nodes) => {
				el.editor.commands.insertContentAt(el.editor.state.doc.content.size, nodes)
			},
			[first, second],
		)
		const fixture = await snapshot()
		const range = await body.evaluate((el) => {
			let start
			let end
			el.editor.state.doc.descendants((node, position) => {
				if (node.isText && node.text === 'Toolbar mixed first') start = position
				if (node.isText && node.text === 'Toolbar mixed second') end = position + node.nodeSize
			})
			return { from: start, to: end }
		})
		await select(range.from, range.to)
		assert.equal(await paragraphStyle.inputValue(), '__mixed__')
		assert.equal(await paragraphStyle.locator('option:checked').innerText(), '混合样式')
		await paragraphStyle.selectOption('heading-2')
		await currentPreview()
		const unified = await snapshot()
		assert.deepEqual(unified.content.slice(0, -2), original.content)
		assert.deepEqual(
			unified.content.slice(-2).map((node) => ({
				type: node.type,
				level: node.attrs.level,
				text: node.content.map((child) => child.text ?? '').join(''),
			})),
			[
				{ type: 'heading', level: 2, text: 'Toolbar mixed first' },
				{ type: 'heading', level: 2, text: 'Toolbar mixed second' },
			],
		)
		assert.equal(await paragraphStyle.inputValue(), 'heading-2')
		await undo()
		assert.deepEqual(await snapshot(), fixture)
		assert.equal(await paragraphStyle.inputValue(), '__mixed__')
		await undo()
		assert.deepEqual(await snapshot(), original)
	}
	passed.push(
		'mixed h1/h2 and paragraph/heading selections can both become heading 2 through the toolbar, with one undo restoring their exact original blocks',
	)

	await select(from + 2)
	await font.selectOption('Liberation Serif')
	await size.selectOption('18pt')
	assert.equal(await font.inputValue(), 'Liberation Serif')
	assert.equal(await size.inputValue(), '18pt')
	assert.deepEqual(await snapshot(), original)
	await toolbar.getByRole('button', { name: '清除文字格式', exact: true }).click()
	assert.equal(await font.inputValue(), '')
	assert.equal(await size.inputValue(), '')
	await page.keyboard.insertText('X')
	const typed = await snapshot()
	assert.equal(
		typed.content[0].content.map((node) => node.text ?? '').join(''),
		'EdXitable overview',
	)
	assert.equal(
		typed.content[0].content.some((node) => node.marks?.length),
		false,
	)
	await undo()
	assert.deepEqual(await snapshot(), original)
	passed.push(
		'caret controls read stored marks; clearing them updates controls and subsequent input without modifying existing text',
	)

	await select(from, to)
	const editorShell = region.locator('.typst-editor')
	const previousStyle = await editorShell.getAttribute('style')
	await editorShell.evaluate((el) => {
		el.style.width = '320px'
		el.style.maxWidth = '320px'
		el.style.overflow = 'hidden'
	})
	await settle()
	assert.equal(page.viewportSize().width, 1440)
	assert.equal(await font.isVisible(), false)
	const shellBounds = await editorShell.boundingBox()
	assert.ok(shellBounds && shellBounds.width <= 321)
	for (const control of [
		size,
		alignment,
		toolbar.getByRole('button', { name: '文字颜色', exact: true }),
		toolbar.getByRole('button', { name: '背景颜色', exact: true }),
		toolbar.getByRole('button', { name: '清除文字格式', exact: true }),
		toolbar.getByRole('button', { name: '格式', exact: true }),
	]) {
		const bounds = await control.boundingBox()
		assert.ok(
			bounds &&
				bounds.x >= shellBounds.x &&
				bounds.x + bounds.width <= shellBounds.x + shellBounds.width + 1,
		)
	}
	const colorButton = toolbar.getByRole('button', { name: '文字颜色', exact: true })
	await colorButton.click()
	const palette = page.getByRole('dialog', { name: '文字颜色', exact: true })
	await palette.waitFor()
	await settle()
	assert.equal(await palette.evaluate((el) => el.contains(el.ownerDocument.activeElement)), true)
	assert.equal(await palette.evaluate((el) => Boolean(el.closest('.typst-editor'))), false)
	await page.keyboard.press('Escape')
	assert.equal(await palette.isVisible(), false)
	assert.equal(await active(colorButton), true)
	await colorButton.click()
	await palette.waitFor()
	const colorInput = palette.getByRole('textbox', { name: '色值', exact: true })
	await colorInput.fill('#123456')
	await colorInput.dispatchEvent('compositionstart', { data: '拼' })
	await settle()
	assert.equal(await palette.getByRole('button', { name: '应用', exact: true }).isDisabled(), true)
	assert.equal(await palette.getByRole('button', { name: '蓝色', exact: true }).isDisabled(), true)
	await colorInput.press('Enter')
	assert.equal(await palette.isVisible(), true)
	assert.deepEqual(await snapshot(), original)
	assert.equal(
		await colorInput.evaluate((el) => {
			const event = new Event('submit', { bubbles: true, cancelable: true })
			el.form.dispatchEvent(event)
			return event.defaultPrevented
		}),
		true,
	)
	assert.equal(await palette.isVisible(), true)
	assert.deepEqual(await snapshot(), original)
	await colorInput.dispatchEvent('compositionend', { data: '拼' })
	await settle()
	assert.equal(await palette.getByRole('button', { name: '应用', exact: true }).isEnabled(), true)
	assert.deepEqual(await selection(), target)
	await page.screenshot({ path: join(dir, 'narrow-pane-palette.png'), fullPage: true })
	await palette.getByRole('button', { name: '应用', exact: true }).click()
	assert.equal(await body.evaluate((el) => el.editor.view.hasFocus()), true)
	assert.deepEqual(await selection(), target)
	assert.equal(
		await body.evaluate(
			(el, at) =>
				el.editor.state.doc.nodeAt(at).marks.find((mark) => mark.type.name === 'textStyle')?.attrs
					.color,
			from,
		),
		'#123456',
	)
	await undo()
	assert.deepEqual(await snapshot(), original)
	await toolbar.getByRole('button', { name: '格式', exact: true }).click()
	await format.waitFor()
	assert.equal(await format.getByRole('combobox', { name: '字体', exact: true }).isVisible(), true)
	await page.keyboard.press('Escape')
	await editorShell.evaluate((el, style) => {
		if (style === null) el.removeAttribute('style')
		else el.setAttribute('style', style)
	}, previousStyle)
	await settle()
	passed.push(
		'a 320px editor pane inside a 1440px viewport retains size/colors/alignment; portal colors preserve selection/focus and reject Enter or form submission during local composition',
	)

	await body.evaluate((el) =>
		el.editor.commands.insertContentAt(el.editor.state.doc.content.size, {
			type: 'table',
			content: [
				{
					type: 'tableRow',
					content: ['Toolbar cell first', 'Toolbar cell second'].map((text) => ({
						type: 'tableCell',
						content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
					})),
				},
			],
		}),
	)
	const cellFixture = await snapshot()
	await body.evaluate((el) => {
		const positions = []
		el.editor.state.doc.descendants((node, position) => {
			if (node.type.name === 'tableCell' && node.textContent.startsWith('Toolbar cell '))
				positions.push(position)
		})
		el.editor.commands.setCellSelection({ anchorCell: positions[0], headCell: positions[1] })
		el.editor.view.focus()
	})
	await settle()
	const cellSelection = await selection()
	assert.equal(cellSelection.type, 'cell')
	assert.notEqual(cellSelection.anchor, cellSelection.head)
	await toolbar.getByRole('button', { name: '格式', exact: true }).click()
	const tableFormat = page.getByRole('dialog', { name: '表格操作', exact: true })
	await tableFormat.waitFor()
	await tableFormat.getByRole('button', { name: '删除线', exact: true }).click()
	assert.equal(await tableFormat.isVisible(), true)
	assert.deepEqual(await selection(), cellSelection)
	assert.deepEqual(
		await body.evaluate((el) => {
			const result = []
			el.editor.state.doc.descendants((node) => {
				if (node.isText && node.text.startsWith('Toolbar cell '))
					result.push({
						text: node.text,
						strike: node.marks.some((mark) => mark.type.name === 'strike'),
					})
			})
			return result
		}),
		[
			{ text: 'Toolbar cell first', strike: true },
			{ text: 'Toolbar cell second', strike: true },
		],
	)
	await currentPreview()
	await page.screenshot({ path: join(dir, 'cell-selection-format.png'), fullPage: true })
	await undo()
	assert.deepEqual(await snapshot(), cellFixture)
	assert.deepEqual(await selection(), cellSelection)
	await undo()
	assert.deepEqual(await snapshot(), original)
	passed.push(
		'the full format entry applies strikethrough to two nonempty selected cells without replacing their native CellSelection, and one undo restores both cells exactly',
	)

	await select(from)
	assert.equal(await toolbar.getByRole('button', { name: '增加缩进', exact: true }).count(), 0)
	await body.evaluate((el) =>
		el.editor.commands.insertContentAt(el.editor.state.doc.content.size, {
			type: 'bulletList',
			content: ['Toolbar first item', 'Toolbar second item'].map((text) => ({
				type: 'listItem',
				content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
			})),
		}),
	)
	const list = await snapshot()
	const itemPosition = await body.evaluate((el) => {
		let found
		el.editor.state.doc.descendants((node, position) => {
			if (node.isText && node.text === 'Toolbar second item') found = position
		})
		return found
	})
	await select(itemPosition)
	await toolbar.getByRole('button', { name: '增加缩进', exact: true }).click()
	assert.equal(await body.locator('ul ul').innerText(), 'Toolbar second item')
	await undo()
	assert.deepEqual(await snapshot(), list)
	await undo()
	assert.deepEqual(await snapshot(), original)
	passed.push(
		'list-only indentation appears from the native context and remains one undoable action',
	)

	await select(from, to)
	await alignment.selectOption('center')
	const aligned = await snapshot()
	await undo()
	assert.deepEqual(await snapshot(), original)
	await toolbar.getByRole('button', { name: '重做', exact: true }).click()
	assert.deepEqual(await snapshot(), aligned)
	assert.match(await body.evaluate((el) => el.editor.getHTML()), /text-align:\s*center/)
	await page.getByRole('button', { name: '保存', exact: true }).click()
	assert.equal(await page.getByTestId('save-state').innerText(), '已保存到本浏览器')
	const oldEditor = await body.evaluateHandle((el) => el.editor)
	await page.getByRole('button', { name: '重开', exact: true }).click()
	await settle()
	assert.equal(await body.evaluate((el, old) => el.editor !== old, oldEditor), true)
	await oldEditor.dispose()
	assert.deepEqual(await snapshot(), aligned)
	assert.equal(await toolbar.getByRole('button', { name: '撤销', exact: true }).isDisabled(), true)
	await select(from, to)
	assert.equal(await alignment.inputValue(), 'center')
	await currentPreview()
	const download = page.waitForEvent('download')
	await page.getByRole('button', { name: '导出当前 PDF', exact: true }).click()
	const downloaded = await download
	await downloaded.saveAs(join(dir, 'aligned.pdf'))
	const pdf = await readFile(join(dir, 'aligned.pdf'))
	assert.equal(pdf.subarray(0, 5).toString(), '%PDF-')
	assert.ok(pdf.length > 1000)
	await page.screenshot({ path: join(dir, 'aligned-reopened.png'), fullPage: true })
	await writeFile(join(dir, 'aligned.json'), JSON.stringify(await snapshot(), null, 2))
	passed.push(
		'native alignment survives one undo/redo, HTML output and saved-draft reopening with fresh history, then exports the current native PDF',
	)
	assert.deepEqual(errors, [])
	assert.deepEqual(failedResponses, [])
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
			{ passed, pageErrors: errors, failedResponses, error: String(error), stack: error.stack },
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
