import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { trackConsumerSessions } from './browser-session.mjs'
import { refactorCases } from './refactor-cases.mjs'

const output = await mkdtemp(join(tmpdir(), 'typst-report-ui-'))
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
const source = page.locator('textarea[aria-label="Typst 源码"]')
const workspace = (name) => page.getByRole('tab', { name, exact: true }).click()
async function current() {
	await page
		.getByTestId('revision')
		.filter({ hasText: / · 当前$/ })
		.waitFor({ timeout: 60000 })
	assert.equal(await page.getByRole('alert').count(), 0)
}
async function applyData(data) {
	await page
		.getByRole('textbox', { name: '外部 JSON 数据', exact: true })
		.fill(JSON.stringify(data))
	await page.getByRole('button', { name: '应用 JSON 数据', exact: true }).click()
}
try {
	await page.goto(process.env.PLUXEL_TYPST_URL ?? 'http://typst.pluxel.localhost:8088')
	await current()
	await page.getByRole('combobox', { name: '示例', exact: true }).selectOption('operations-report')
	await body.getByRole('img', { name: '青山品牌插图', exact: true }).waitFor()
	await page
		.getByTestId('revision')
		.filter({ hasText: /草稿 2 \/ 预览 2 · 当前$/ })
		.waitFor()
	await current()
	assert.ok(
		await body
			.getByRole('img', { name: '青山品牌插图', exact: true })
			.evaluate((img) => img.complete && img.naturalWidth > 0),
	)
	const initialVector = compiled.preview.data
	await page.screenshot({ path: join(output, 'initial.png'), fullPage: true })
	// Ordinary typing creates a native undo step; a later data update must preserve it.
	await body.locator('p').first().click()
	await page.keyboard.press('End')
	await page.keyboard.insertText(' 已核验渠道差异。')
	await current()
	const edited = await body.evaluate((element) => element.editor.getJSON())
	await workspace('数据')
	const samplePath = join(import.meta.dirname, 'public/examples/operations-report.json')
	await page.getByLabel('导入 JSON 文件', { exact: true }).setInputFiles(samplePath)
	const data = JSON.parse(await readFile(samplePath, 'utf8'))
	data.company = '外部数据 · 远山服务有限公司'
	data.channels[0].actual = 80
	data.channels[1].target = 0
	await applyData(data)
	await current()
	assert.deepEqual(await body.evaluate((element) => element.editor.getJSON()), edited)
	assert.match(await body.innerText(), /外部数据 · 远山服务有限公司/)
	assert.notDeepEqual(compiled.preview.data, initialVector)
	await workspace('正文')
	await page.screenshot({ path: join(output, 'data-updated.png'), fullPage: true })
	const toolbar = page
		.getByTestId('region-body')
		.getByRole('toolbar', { name: '正文格式', exact: true })
	await toolbar.getByRole('button', { name: '撤销', exact: true }).click()
	assert.doesNotMatch(await body.innerText(), /已核验渠道差异/)
	assert.match(await body.innerText(), /外部数据 · 远山服务有限公司/)
	await toolbar.getByRole('button', { name: '重做', exact: true }).click()
	await current()
	// Invalid external JSON preserves both the admitted data and edited body.
	await workspace('数据')
	const beforeInvalid = await page.getByTestId('revision').innerText()
	await applyData({ ...data, channels: [] })
	await page.getByRole('alert').waitFor()
	assert.equal(await page.getByTestId('revision').innerText(), beforeInvalid)
	assert.deepEqual(await body.evaluate((element) => element.editor.getJSON()), edited)
	await applyData(data)
	await current()
	await workspace('原始 Typst')
	const templatePath = join(import.meta.dirname, 'public/examples/operations-report.typ')
	await page.getByLabel('导入 Typst 模板文件', { exact: true }).setInputFiles(templatePath)
	const templateSource = await readFile(templatePath, 'utf8')
	const template = templateSource.replace('渠道经营报告', '外部模板 · 渠道复盘')
	await current()
	await source.fill(template)
	await current()
	assert.match(await source.inputValue(), /外部模板 · 渠道复盘/)
	assert.deepEqual(await body.evaluate((element) => element.editor.getJSON()), edited)
	// Compiler failures keep candidate source, mark preview stale, and block stale PDF export.
	await source.fill('#let = invalid')
	await page.getByRole('alert').waitFor()
	await page
		.getByTestId('revision')
		.filter({ hasText: / · 过期$/ })
		.waitFor()
	assert.equal(
		await page.getByRole('button', { name: '导出当前 PDF', exact: true }).isDisabled(),
		true,
	)
	assert.equal(await source.inputValue(), '#let = invalid')
	await source.fill(template)
	await current()
	await workspace('正文')
	await page.getByRole('button', { name: '保存', exact: true }).click()
	await page.getByRole('combobox', { name: '示例', exact: true }).selectOption('consumer-report')
	await body.getByText('Editable overview', { exact: true }).waitFor()
	await current()
	await page.getByRole('button', { name: '重开', exact: true }).click()
	await body.getByRole('img', { name: '青山品牌插图', exact: true }).waitFor()
	await current()
	assert.equal(
		await page.getByRole('combobox', { name: '示例', exact: true }).inputValue(),
		'operations-report',
	)
	assert.deepEqual(await body.evaluate((element) => element.editor.getJSON()), edited)
	assert.match(await source.inputValue(), /外部模板 · 渠道复盘/)
	// A preview click opens the matching source tab, without remounting the editor.
	await workspace('数据')
	await workspace('Typst 预览')
	await page.locator('.preview-scroll').evaluate((element) => {
		element.scrollTop = 0
	})
	const fixed = compiled.preview.navigation.points.find(
		(item) =>
			item.path === 'main.typ' &&
			item.page === 1 &&
			item.line ===
				template.split('\n').findIndex((line) => line.includes('外部模板 · 渠道复盘')) + 1,
	)
	assert.ok(fixed)
	const fixedScreen = await page
		.locator('.typst-page')
		.first()
		.evaluate((element, target) => {
			const point = new DOMPoint(
				target.x + target.width / 2,
				target.y + target.height / 2,
			).matrixTransform(element.getScreenCTM())
			return { x: point.x, y: point.y }
		}, fixed)
	await page.mouse.click(fixedScreen.x, fixedScreen.y)
	await source.waitFor({ state: 'visible' })
	assert.equal(
		await page.getByRole('tab', { name: '原始 Typst', exact: true }).getAttribute('aria-selected'),
		'true',
	)
	const fixedOffset =
		template
			.split('\n')
			.slice(0, fixed.line - 1)
			.reduce((sum, line) => sum + line.length + 1, 0) +
		fixed.column -
		1
	assert.equal(await source.evaluate((element) => element.selectionStart), fixedOffset)
	await workspace('数据')
	await workspace('Typst 预览')
	// After data/template replacement, a click in the preview still places a character caret.
	const position = await body.evaluate((element) => {
		let found
		element.editor.state.doc.descendants((node, offset) => {
			if (node.text?.includes('核对新增客户')) found = offset + 4
		})
		return found
	})
	const entry = compiled.mapping.find(
		(item) => item.regionId === 'body' && item.kind === 'text' && item.from === position,
	)
	const point = compiled.preview.navigation.points.find(
		(item) =>
			item.path === entry.path &&
			item.line === entry.range.start.line &&
			item.column === entry.range.start.column,
	)
	const svg = page.locator('.typst-page').nth(point.page - 1)
	await svg.scrollIntoViewIfNeeded()
	const screen = await svg.evaluate((element, target) => {
		const screenPoint = new DOMPoint(
			target.x + target.width / 2,
			target.y + target.height / 2,
		).matrixTransform(element.getScreenCTM())
		return { x: screenPoint.x, y: screenPoint.y }
	}, point)
	await page.mouse.click(screen.x, screen.y)
	await page.waitForFunction(
		(expected) =>
			document.querySelector('[data-testid="region-body"] .tiptap').editor.state.selection.from ===
			expected,
		position,
	)
	assert.equal(
		await page.getByRole('tab', { name: '正文', exact: true }).getAttribute('aria-selected'),
		'true',
	)
	await page.setViewportSize({ width: 390, height: 844 })
	await body.scrollIntoViewIfNeeded()
	assert.equal(
		await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
		false,
	)
	await page.screenshot({ path: join(output, 'mobile.png') })
	await page.setViewportSize({ width: 1440, height: 1100 })
	const download = page.waitForEvent('download')
	await page.getByRole('button', { name: '导出当前 PDF', exact: true }).click()
	const file = await download
	await file.saveAs(join(output, 'report.pdf'))
	assert.deepEqual(errors, [])
	await refactorCases({
		browser,
		url: process.env.PLUXEL_TYPST_URL ?? 'http://typst.pluxel.localhost:8088',
		output: join(output, 'refactor'),
	})
	await writeFile(
		join(output, 'result.json'),
		JSON.stringify({ position, revision: compiled.clientRevision, errors }, null, 2),
	)
	console.log(JSON.stringify({ output, position, revision: compiled.clientRevision, errors }))
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
