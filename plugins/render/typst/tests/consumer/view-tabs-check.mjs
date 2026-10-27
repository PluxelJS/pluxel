import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { trackConsumerSessions } from './browser-session.mjs'

// Reuse the user's browser service and managed app; never launch either here.
const output = await mkdtemp(join(tmpdir(), 'typst-view-tabs-ui-'))
const browser = await chromium.connect(
	process.env.PLAYWRIGHT_WS_ENDPOINT ?? 'ws://127.0.0.1:3000',
	{
		timeout: 5000,
		exposeNetwork: '<loopback>',
	},
)
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()
const releaseSessions = trackConsumerSessions(page)
const errors = []
page.on('pageerror', (error) => errors.push(String(error)))
page.on('dialog', (dialog) => dialog.dismiss())
const body = page.getByTestId('region-body').locator('.tiptap')
const live = page.getByRole('textbox', { name: '实时 Markdown', exact: true })
const candidate = page.getByRole('textbox', { name: '候选 Markdown', exact: true })
const scope = page.getByRole('combobox', { name: '候选修改范围', exact: true })
const button = (name) => page.getByRole('button', { name, exact: true })
const tab = (name) => page.getByRole('tab', { name, exact: true }).click()
const doc = () => body.evaluate((element) => element.editor.getJSON())
async function current() {
	await page
		.getByTestId('revision')
		.filter({ hasText: / · 当前$/ })
		.waitFor({ timeout: 60000 })
	assert.equal(await page.getByRole('alert').count(), 0)
}
async function accept() {
	await button('查看修改预览').click()
	await button('接纳候选').click()
	await live.waitFor()
	await current()
}
async function bounded() {
	assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
}
try {
	const url = new URL(process.env.PLUXEL_TYPST_URL ?? 'http://typst.pluxel.localhost:8088')
	url.searchParams.delete('example')
	await page.goto(url.href)
	await body.locator('[data-block-id="channels-primary"]').waitFor()
	await current()
	assert.equal(
		await page.getByRole('combobox', { name: '示例', exact: true }).inputValue(),
		'operations-report',
	)
	await page.screenshot({ path: join(output, 'desktop-preview.png'), fullPage: true })
	await tab('Markdown')
	assert.match(await live.inputValue(), /fontFamily.*fontSize.*color.*backgroundColor/)
	assert.match(await live.inputValue(), /"template":"channels"/)
	assert.match(await live.inputValue(), /"typstTableStyle":"three-line"/)
	const bounds = await Promise.all(
		['.editing', '.output-pane'].map((selector) => page.locator(selector).boundingBox()),
	)
	assert.ok(bounds[0].x + bounds[0].width < bounds[1].x)
	assert.equal(await page.locator('.preview-pane').isVisible(), false)
	assert.equal(
		await page
			.getByRole('tablist', { name: '文档视图' })
			.getByRole('tab')
			.allTextContents()
			.then((labels) => labels.join('|')),
		'Typst 预览|原始 Typst|Markdown',
	)
	await bounded()
	await page.screenshot({ path: join(output, 'desktop.png'), fullPage: true })

	const original = await doc()
	// Native selection inside the paragraph after the cover; the surrounding chart and table stay intact.
	await body.evaluate((element) => element.editor.commands.setTextSelection(2))
	await scope.selectOption('blocks')
	assert.match(await live.inputValue(), /下一步判断/)
	assert.doesNotMatch(await live.inputValue(), /templateBlock|typstTableStyle/)
	await button('编辑这份 Markdown').click()
	const paragraphMarkdown = await candidate.inputValue()
	await candidate.fill(
		paragraphMarkdown.replace('下一步判断', '本周行动').replace('#28745c', '#c93434'),
	)
	await accept()
	const changed = await doc()
	assert.deepEqual(
		changed.content.filter((_, index) => index !== 1),
		original.content.filter((_, index) => index !== 1),
	)
	assert.match(JSON.stringify(changed.content[1]), /本周行动/)
	assert.match(JSON.stringify(changed.content[1]), /#c93434/)
	await scope.selectOption('region')
	await page.screenshot({ path: join(output, 'paragraph-applied.png'), fullPage: true })
	await page.getByTestId('region-body').getByRole('button', { name: '撤销', exact: true }).click()
	await current()
	assert.deepEqual(await doc(), original)
	assert.match(await live.inputValue(), /下一步判断/)

	// Template semantics and table styles remain editable through the same Markdown path.
	await button('编辑这份 Markdown').click()
	const regionMarkdown = await candidate.inputValue()
	await candidate.fill(
		regionMarkdown
			.replace('"title":"渠道收入与目标"', '"title":"渠道对照演示"')
			.replace('"typstTableStyle":"three-line"', '"typstTableStyle":"borderless"'),
	)
	await accept()
	const componentDocument = await doc()
	assert.equal(
		componentDocument.content
			.flatMap((node) => (node.type === 'figure' ? node.content : [node]))
			.find((node) => node.type === 'templateBlock').attrs.props.title,
		'渠道对照演示',
	)
	assert.equal(
		componentDocument.content
			.flatMap((node) => (node.type === 'figure' ? node.content : [node]))
			.find((node) => node.type === 'table').attrs.typstTableStyle,
		'borderless',
	)
	await tab('Typst 预览')
	assert.match(await page.locator('.preview-scroll').innerText(), /渠道对照演示/)
	assert.doesNotMatch(
		await page.getByRole('navigation', { name: '目录', exact: true }).innerText(),
		/渠道对照演示/,
	)

	await tab('Markdown')

	// A new native edit cannot silently replace or rebase an in-progress Markdown candidate.
	await button('编辑这份 Markdown').click()
	const fixed = await candidate.inputValue()
	await candidate.fill(`${fixed}\n\nPending agent edit`)
	await tab('原始 Typst')
	await page.getByTestId('save-state').filter({ hasText: '有未应用输入' }).waitFor()
	await tab('Typst 预览')
	await tab('Markdown')
	assert.equal(await candidate.inputValue(), `${fixed}\n\nPending agent edit`)
	await body.evaluate((element) => element.editor.commands.insertContentAt(2, '人工修改：'))
	assert.equal(await candidate.inputValue(), `${fixed}\n\nPending agent edit`)
	await button('查看修改预览').click()
	await page
		.getByRole('alert')
		.filter({ hasText: /STALE_CANDIDATE/ })
		.waitFor()
	assert.doesNotMatch(JSON.stringify(await doc()), /Pending agent edit/)
	await button('放弃候选修改').click()
	await page.getByTestId('save-state').filter({ hasNotText: '有未应用输入' }).waitFor()
	await current()
	assert.match(await live.inputValue(), /人工修改/)

	await page.getByRole('tab', { name: '原始 Typst', exact: true }).click()
	const template = page.getByRole('textbox', { name: 'Typst 源码', exact: true })
	const templateSource = await template.inputValue()
	await template.fill(templateSource.replace('渠道经营报告', '标签对照报告'))
	await current()
	await page.screenshot({ path: join(output, 'template.png'), fullPage: true })
	await page.getByRole('tab', { name: '数据', exact: true }).click()
	const data = page.getByRole('textbox', { name: '外部 JSON 数据', exact: true })
	const nextData = JSON.parse(await data.inputValue())
	nextData.company = '标签演示公司'
	await data.fill(JSON.stringify(nextData))
	await button('应用 JSON 数据').click()
	await current()
	await page.getByRole('tab', { name: '正文', exact: true }).click()
	assert.match(await body.innerText(), /标签演示公司/)
	await tab('Markdown')
	assert.match(await live.inputValue(), /\[dataField \{"path":\["company"\]\}\]/)

	// Tab changes preserve the same native Editor, selection, history and source input.
	await body.evaluate((element) => {
		window.tabsEditor = element.editor
	})
	await page.getByRole('tab', { name: 'Markdown', exact: true }).focus()
	await page.keyboard.press('Home')
	assert.equal(
		await page.getByRole('tab', { name: 'Typst 预览', exact: true }).getAttribute('aria-selected'),
		'true',
	)
	await page.keyboard.press('ArrowRight')
	assert.equal(
		await page.getByRole('tab', { name: '原始 Typst', exact: true }).getAttribute('aria-selected'),
		'true',
	)
	assert.match(await template.inputValue(), /标签对照报告/)
	await page.keyboard.press('End')
	await live.waitFor()
	assert.match(await live.inputValue(), /人工修改/)
	await page.setViewportSize({ width: 390, height: 844 })
	await bounded()
	await page.screenshot({ path: join(output, 'mobile-editor.png'), fullPage: true })
	await button('预览').click()
	await live.waitFor()
	assert.equal(await body.isVisible(), false)
	await bounded()
	await page.screenshot({ path: join(output, 'mobile-markdown.png'), fullPage: true })
	await tab('原始 Typst')
	await template.waitFor()
	await bounded()
	await page.screenshot({ path: join(output, 'mobile-source.png'), fullPage: true })
	await tab('Typst 预览')
	assert.equal(await page.locator('.preview-pane').isVisible(), true)
	assert.equal(await live.isVisible(), false)
	await bounded()
	await page.screenshot({ path: join(output, 'mobile-preview.png'), fullPage: true })
	await button('编辑').click()
	assert.equal(await body.evaluate((element) => element.editor === window.tabsEditor), true)
	assert.deepEqual(errors, [])
	await writeFile(
		join(output, 'result.json'),
		JSON.stringify(
			{
				ok: true,
				checks: [
					'two panes with three output tabs',
					'rich Markdown',
					'paragraph apply/undo and surrounding preservation',
					'template and table metadata',
					'stale candidate rejection',
					'template source',
					'live data binding',
					'tab and keyboard navigation preserve drafts and history',
					'mobile panes',
				],
				errors,
			},
			null,
			2,
		),
	)
	console.log(output)
} catch (error) {
	await page.screenshot({ path: join(output, 'failure.png'), fullPage: true })
	console.error(output)
	throw error
} finally {
	try {
		await releaseSessions()
	} finally {
		await context.close()
		await browser.close()
	}
}
