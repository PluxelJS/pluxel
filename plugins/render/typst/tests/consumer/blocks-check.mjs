import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { trackConsumerSessions } from './browser-session.mjs'

const output = await mkdtemp(join(tmpdir(), 'typst-blocks-ui-'))
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
const body = page.getByTestId('region-body').locator('.tiptap')
const notes = page.getByTestId('region-notes').locator('.tiptap')
const chart = body.locator('[data-block-id="channels-primary"]')
const raw = notes.locator('[data-block-id="source-note"]')
const input = raw.getByRole('textbox', { name: '组件 Typst 源码', exact: true })
const workspace = (name) => page.getByRole('tab', { name, exact: true }).click()
const documentJson = (region) => region.evaluate((element) => element.editor.getJSON())
const undo = (region) =>
	page
		.getByTestId(`region-${region}`)
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
async function clickPoint(point) {
	const svg = page.locator('.typst-page').nth(point.page - 1)
	await svg.scrollIntoViewIfNeeded()
	await svg.evaluate((element, target) => {
		const screen = new DOMPoint(
			target.x + target.width / 2,
			target.y + target.height / 2,
		).matrixTransform(element.getScreenCTM())
		const parent = element.closest('.preview-scroll')
		const bounds = parent.getBoundingClientRect()
		if (screen.y > bounds.bottom - 25) parent.scrollTop += screen.y - bounds.bottom + 25
		if (screen.y < bounds.top + 25) parent.scrollTop += screen.y - bounds.top - 25
	}, point)
	const screen = await svg.evaluate((element, target) => {
		const projected = new DOMPoint(
			target.x + target.width / 2,
			target.y + target.height / 2,
		).matrixTransform(element.getScreenCTM())
		return { x: projected.x, y: projected.y }
	}, point)
	await page.mouse.click(screen.x, screen.y)
}
try {
	await page.goto(process.env.PLUXEL_TYPST_URL ?? 'http://typst.pluxel.localhost:8088')
	await current()
	await page.getByRole('combobox', { name: '示例', exact: true }).selectOption('operations-report')
	await chart.waitFor()
	await current()
	const original = await documentJson(body)
	const originalNotes = await documentJson(notes)
	const chartIndex = original.content.findIndex((node) => node.type === 'templateBlock')
	for (const label of ['上移', '下移', '定位预览', '复制', '删除'])
		assert.equal(await chart.getByRole('button', { name: label, exact: true }).count(), 0)
	assert.equal(
		await chart.locator('textarea').count(),
		0,
		'Template parameters are inspected, not edited in a second JSON editor',
	)
	await chart.locator('.typst-block-title').click()
	await page
		.getByTestId('navigation')
		.filter({ hasText: /^preview:_editor\/blocks\/body\/channels-primary.typ:/ })
		.waitFor()
	assert.equal(await chart.getAttribute('data-selected'), 'true')
	await page.screenshot({ path: join(output, 'components-desktop-collapsed.png'), fullPage: true })
	await body.locator('p').first().click()
	const beforeInspectNavigation = await page.getByTestId('navigation').innerText()
	await chart.locator('summary').click()
	assert.equal(
		await page.getByTestId('navigation').innerText(),
		beforeInspectNavigation,
		'Opening parameters does not jump the preview',
	)
	assert.deepEqual(
		JSON.parse(await chart.getByLabel('组件参数', { exact: true }).innerText()),
		original.content[chartIndex].attrs.props,
	)
	const initialData = JSON.parse(await chart.getByLabel('组件数据', { exact: true }).innerText())
	assert.ok(initialData.channels.length > 0)
	await page.screenshot({ path: join(output, 'components-desktop-expanded.png'), fullPage: true })
	await chart.locator('summary').click()
	const menu = chart.getByRole('menu', { name: '块操作', exact: true })
	await chart.getByRole('button', { name: '块操作', exact: true }).click()
	await menu.waitFor()
	await page.screenshot({ path: join(output, 'block-menu-desktop.png'), fullPage: true })
	await page.keyboard.press('Escape')
	await menu.waitFor({ state: 'hidden' })
	await chart.locator('.typst-block-title').click({ button: 'right' })
	await menu.getByRole('menuitem', { name: '复制一份', exact: true }).click()
	const copiedDocument = await documentJson(body)
	const copied = copiedDocument.content.filter((node) => node.type === 'templateBlock')
	assert.equal(copied.length, 2)
	assert.notEqual(copied[0].attrs.id, copied[1].attrs.id)
	assert.deepEqual({ ...copied[0].attrs, id: '' }, { ...copied[1].attrs, id: '' })
	await current()
	// A data-only update changes the inspected input without replacing document JSON or history.
	await workspace('数据')
	const updatedData = {
		...initialData,
		company: '更新后的绑定数据',
		channels: initialData.channels.map((channel, index) => ({
			name: channel.name,
			target: channel.target,
			actual: channel.actual + index + 1,
		})),
	}
	await page
		.getByRole('textbox', { name: '外部 JSON 数据', exact: true })
		.fill(JSON.stringify(updatedData))
	await page.getByRole('button', { name: '应用 JSON 数据', exact: true }).click()
	await current()
	assert.deepEqual(await documentJson(body), copiedDocument)
	await workspace('正文')
	await chart.locator('summary').click()
	assert.deepEqual(
		JSON.parse(await chart.getByLabel('组件数据', { exact: true }).innerText()),
		updatedData,
	)
	await chart.locator('summary').click()
	await undo('body')
	assert.deepEqual(
		await documentJson(body),
		original,
		'Data inspection updates preserve the preceding copy undo step',
	)
	await current()
	await chart.getByRole('button', { name: '块操作', exact: true }).click()
	await menu.getByRole('menuitem', { name: '删除', exact: true }).click()
	assert.equal(await chart.count(), 0)
	await current()
	await undo('body')
	assert.deepEqual(await documentJson(body), original, 'Menu deletion is one native undo step')
	await current()
	await chart.locator('.typst-block-title').click()
	await page.keyboard.press('Delete')
	assert.equal(await chart.count(), 0, 'Native Delete removes the selected atom')
	await current()
	await undo('body')
	assert.deepEqual(await documentJson(body), original)
	await current()
	// Exercise the native drag/drop route, preserving the node and its instance ID.
	await chart.locator('[data-drag-handle]').dragTo(body, { targetPosition: { x: 32, y: 10 } })
	await page.waitForFunction(
		() =>
			document.querySelector('[data-testid="region-body"] .tiptap').editor.getJSON().content[0]
				?.attrs?.id === 'channels-primary',
		null,
		{ timeout: 10000 },
	)
	const dragged = await documentJson(body)
	assert.deepEqual(dragged.content[0], original.content[chartIndex])
	await current()
	await undo('body')
	assert.deepEqual(
		await documentJson(body),
		original,
		'Native drag is undoable and retains the stable ID',
	)
	await current()
	await chart.locator('summary').click()
	await page.screenshot({ path: join(output, 'components-desktop.png'), fullPage: true })
	await chart.locator('summary').click()

	// Markdown replaces just the selected heading. Other authored and generated nodes survive.
	await body.locator('h1').click()
	await workspace('AI 候选')
	await page.getByRole('combobox', { name: '候选修改范围', exact: true }).selectOption('blocks')
	await page
		.getByRole('textbox', { name: '候选 Markdown', exact: true })
		.fill(
			'## LLM 经营解读\n\n新增分析由 Markdown 接纳，图表保持原样。\n\n```typst\n#text[这里是代码示例]\n```',
		)
	await page.getByRole('checkbox', { name: '允许接纳候选', exact: true }).check()
	await page.getByRole('button', { name: '固定候选目标', exact: true }).click()
	await page.getByRole('button', { name: '查看修改预览', exact: true }).click()
	await page.getByRole('button', { name: '接纳候选', exact: true }).click()
	await body.getByText('LLM 经营解读', { exact: true }).waitFor()
	await current()
	const accepted = await documentJson(body)
	assert.deepEqual(
		accepted.content.filter((node) => ['templateBlock', 'table', 'image'].includes(node.type)),
		original.content.filter((node) => ['templateBlock', 'table', 'image'].includes(node.type)),
	)
	assert.equal(accepted.content.filter((node) => node.type === 'typstSource').length, 0)
	assert.ok(
		accepted.content.some((node) => node.type === 'codeBlock' && node.attrs.language === 'typst'),
	)
	assert.deepEqual(await documentJson(notes), originalNotes)
	await undo('body')
	assert.deepEqual(await documentJson(body), original)
	await current()

	await page
		.getByRole('navigation', { name: '正文区域', exact: true })
		.getByRole('button', { name: '后续行动', exact: true })
		.click()
	await raw.locator('summary').click()
	const stored = await input.inputValue()
	await page.getByRole('checkbox', { name: '区域只读', exact: true }).check()
	assert.equal(await input.getAttribute('readonly'), '')
	for (const label of ['块操作', '应用组件修改'])
		assert.equal(await raw.getByRole('button', { name: label, exact: true }).isDisabled(), true)
	assert.equal(await raw.locator('[data-drag-handle]').count(), 0)
	await page.getByRole('checkbox', { name: '区域只读', exact: true }).uncheck()
	await page.waitForFunction(
		() => !document.querySelector('textarea[aria-label="组件 Typst 源码"]').readOnly,
		null,
		{ timeout: 5000 },
	)
	assert.equal(await input.getAttribute('readonly'), null)
	await input.dispatchEvent('compositionstart', { data: '' })
	assert.equal(
		await input.getAttribute('readonly'),
		null,
		'IME must not turn its own input readonly',
	)
	assert.equal(await raw.getByRole('button', { name: '块操作', exact: true }).isDisabled(), true)
	assert.equal(await raw.locator('[data-drag-handle]').count(), 0)
	const source =
		'#text(size: 9pt, fill: blue)[核验记录：中文输入已保留 #data.analyst]\n#text(size: 9pt)[源码跳转应保留字符位置。]'
	await input.fill(source)
	assert.equal(await input.inputValue(), source)
	const duringComposition = await documentJson(notes)
	assert.equal(
		duringComposition.content.find((node) => node.type === 'typstSource').attrs.source,
		stored,
		'Settings remain a local candidate during composition',
	)
	await input.dispatchEvent('compositionend', { data: '中文输入已保留' })
	await raw.getByRole('button', { name: '应用组件修改', exact: true }).click()
	await current()
	const applied = await documentJson(notes)
	assert.equal(applied.content.find((node) => node.type === 'typstSource').attrs.source, source)
	await input.fill('#let = invalid')
	await raw.getByRole('button', { name: '应用组件修改', exact: true }).click()
	await page
		.getByTestId('revision')
		.filter({ hasText: / · 过期$/ })
		.waitFor()
	await page.getByRole('alert').waitFor()
	assert.equal(
		await page.getByRole('button', { name: '导出当前 PDF', exact: true }).isDisabled(),
		true,
	)
	assert.equal(await input.inputValue(), '#let = invalid')
	await input.fill(source)
	await raw.getByRole('button', { name: '应用组件修改', exact: true }).click()
	await current()
	const point = compiled.preview.navigation.points.find(
		(entry) =>
			entry.path.endsWith('/notes/source-note.typ') && entry.line === 3 && entry.column > 21,
	)
	assert.ok(point, 'The native compiler exposes a character hit in source, beyond the prefix')
	const offset =
		source
			.split('\n')
			.slice(0, point.line - 2)
			.reduce((sum, line) => sum + line.length + 1, 0) +
		point.column -
		1
	await raw.locator('summary').click()
	await workspace('数据')
	await clickPoint(point)
	await input.waitFor({ state: 'visible' })
	await page.waitForFunction(
		(expected) =>
			document.querySelector('textarea[aria-label="组件 Typst 源码"]')?.selectionStart === expected,
		offset,
	)
	assert.equal(await input.evaluate((element) => element === document.activeElement), true)
	const dirty = '// 尚未应用的前缀\n' + source
	await input.fill(dirty)
	await input.evaluate((element) => element.setSelectionRange(8, 8))
	await clickPoint(point)
	await raw.getByRole('alert').filter({ hasText: '存在未应用修改，请应用后再定位源码。' }).waitFor()
	assert.equal(await input.inputValue(), dirty)
	assert.equal(
		await input.evaluate((element) => element.selectionStart),
		8,
		'Preview navigation must not invent a caret in unapplied source',
	)
	await input.fill(source)
	await clickPoint(point)
	await raw.getByRole('alert').waitFor({ state: 'hidden' })
	await current()
	await page.screenshot({ path: join(output, 'source-navigation.png'), fullPage: true })

	await notes.locator('p').first().click()
	const format = page.getByRole('dialog', { name: '文字格式', exact: true })
	const openFormat = () =>
		page.getByTestId('region-notes').getByRole('button', { name: '格式', exact: true }).click()
	await openFormat()
	const typography = format.getByRole('toolbar', { name: '排版扩展', exact: true })
	await typography.getByRole('button', { name: '文字颜色', exact: true }).click()
	const textPalette = page.getByRole('dialog', { name: '文字颜色', exact: true })
	await textPalette.waitFor()
	await page.keyboard.press('ArrowRight')
	assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), '灰色')
	await page.screenshot({ path: join(output, 'text-color-desktop.png'), fullPage: true })
	await page.keyboard.press('Escape')
	assert.equal(await format.isVisible(), true, 'Escape closes the palette before the format panel')
	await page.keyboard.press('Escape')
	await format.waitFor({ state: 'hidden' })
	await page.setViewportSize({ width: 390, height: 844 })
	await page
		.getByRole('navigation', { name: '正文区域', exact: true })
		.getByRole('button', { name: '经营解读', exact: true })
		.click()
	await chart.scrollIntoViewIfNeeded()
	await page.screenshot({ path: join(output, 'template-mobile-collapsed.png') })
	await chart.locator('summary').click()
	await chart.getByLabel('组件数据', { exact: true }).scrollIntoViewIfNeeded()
	await page.screenshot({ path: join(output, 'template-mobile-expanded.png') })
	await chart.getByRole('button', { name: '块操作', exact: true }).click()
	await page.screenshot({ path: join(output, 'template-menu-mobile.png') })
	await page.keyboard.press('Escape')
	await chart.locator('summary').click()
	await page
		.getByRole('navigation', { name: '正文区域', exact: true })
		.getByRole('button', { name: '后续行动', exact: true })
		.click()
	await raw.scrollIntoViewIfNeeded()
	assert.equal(
		await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
		false,
	)
	await page.screenshot({ path: join(output, 'components-mobile.png') })
	await raw.getByRole('button', { name: '块操作', exact: true }).click()
	const mobileMenu = raw.getByRole('menu', { name: '块操作', exact: true })
	const menuBounds = await mobileMenu.boundingBox()
	assert.ok(
		menuBounds &&
			menuBounds.x >= 0 &&
			menuBounds.y >= 0 &&
			menuBounds.x + menuBounds.width <= 390 &&
			menuBounds.y + menuBounds.height <= 844,
	)
	await page.screenshot({ path: join(output, 'block-menu-mobile.png') })
	await page.keyboard.press('Escape')
	await notes.locator('p').first().click()
	await openFormat()
	await typography.scrollIntoViewIfNeeded()
	await typography.getByRole('button', { name: '背景颜色', exact: true }).click()
	const background = page.getByRole('dialog', { name: '背景颜色', exact: true })
	const bounds = await background.boundingBox()
	assert.ok(
		bounds &&
			bounds.x >= 0 &&
			bounds.y >= 0 &&
			bounds.x + bounds.width <= 390 &&
			bounds.y + bounds.height <= 844,
	)
	await page.screenshot({ path: join(output, 'background-color-mobile.png') })
	await page.keyboard.press('Escape')
	assert.deepEqual(errors, [])
	await writeFile(join(output, 'result.json'), JSON.stringify({ offset, point, errors }, null, 2))
	console.log(JSON.stringify({ output, offset, errors }))
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
