import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright'
import { trackConsumerSessions } from './browser-session.mjs'

const output = resolve(
	process.env.TYPST_SOURCE_EVIDENCE ??
		new URL(
			'../../../../../projects/typst-agent-workspace/evidence/source/browser',
			import.meta.url,
		).pathname,
)
await mkdir(output, { recursive: true })
const browser = await chromium.connect(
	process.env.PLAYWRIGHT_WS_ENDPOINT ?? 'ws://127.0.0.1:3000',
	{ exposeNetwork: '<loopback>', timeout: 5000 },
)
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
const page = await context.newPage()
const release = trackConsumerSessions(page)
const errors = [],
	checks = []
page.on('pageerror', (error) => errors.push(String(error)))
const button = (name) => page.getByRole('button', { name, exact: true })
const sourceFiles = async () => {
	await button('保存项目').click()
	return page.evaluate(() => JSON.parse(localStorage.getItem('typst-source-project-v1')))
}
const current = async () => {
	await button('下载 PDF').waitFor({ timeout: 45000 })
	await page.waitForFunction(
		() =>
			![...document.querySelectorAll('button')].find(
				(element) => element.textContent === '下载 PDF',
			)?.disabled,
		undefined,
		{ timeout: 45000 },
	)
	assert.deepEqual(await page.locator('.source-failure').allTextContents(), [])
}
const selectText = async (targetText, atEnd = false) => {
	await page.locator('.tiptap').evaluate(
		(element, { text, end }) => {
			const editor = element.editor
			let at
			editor.state.doc.descendants((node, position) => {
				if (at === undefined && node.isText && node.text.includes(text))
					at = position + node.text.indexOf(text)
			})
			if (at === undefined) throw new Error(`Text missing: ${text}`)
			editor.commands.setTextSelection(end ? at + text.length : { from: at, to: at + text.length })
			editor.view.focus()
		},
		{ text: targetText, end: atEnd },
	)
}
try {
	await page.goto(process.env.PLUXEL_TYPST_URL ?? 'http://127.0.0.1:3410')
	await current()
	const before = await sourceFiles()
	await button('保存项目').click()
	assert.deepEqual(await sourceFiles(), before)
	checks.push('无操作保存所有文件字节不变')

	await selectText('本季度营收增长，详细原因待补充。')
	assert.equal(
		await page.evaluate(() => getSelection().toString()),
		'本季度营收增长，详细原因待补充。',
	)
	await page.keyboard.insertText('本季度营收增长，已核对中文合同与回款。')
	await current()
	let files = await sourceFiles()
	assert.equal(
		files['sections/analysis.typ'],
		before['sections/analysis.typ'].replace(
			'本季度营收增长，详细原因待补充。',
			'本季度营收增长，已核对中文合同与回款。',
		),
	)
	checks.push('真实浏览器选区和中文输入只改目标源字节')

	await selectText('本季度营收增长，已核对中文合同与回款。', true)
	await page.keyboard.insertText('见 @fig:rev')
	await page.getByRole('listbox', { name: '引用图、表或公式' }).waitFor()
	await page.getByRole('option').filter({ hasText: 'fig:revenue' }).first().click()
	await current()
	files = await sourceFiles()
	assert.match(files['sections/analysis.typ'], /回款。见 @fig:revenue/)
	checks.push('@ 搜索并插入原生跨文件可见引用')

	await selectText('季度营收对比，单位：')
	await page.keyboard.insertText('季度营收核对，单位：')
	await current()
	const label = page.getByRole('textbox', { name: '图引用 label', exact: true }).first()
	await label.fill('fig:revenue-reviewed')
	await label.press('Enter')
	await current()
	files = await sourceFiles()
	assert.match(files['sections/analysis.typ'], /季度营收核对/)
	assert.match(files['sections/analysis.typ'], /<fig:revenue-reviewed>/)
	assert.match(files['sections/actions.typ'], /@fig:revenue-reviewed/)
	assert.doesNotMatch(files['sections/actions.typ'], /@fig:revenue(?!-)/)
	checks.push('富文本题注和 label 编辑、跨文件引用原子跟随')

	await button('#upper("q3")').click()
	await page.getByRole('textbox', { name: 'Typst 源码', exact: true }).fill('#upper("q4")')
	assert.equal(await button('下载 PDF').isDisabled(), true)
	await page.getByRole('combobox', { name: '源文件' }).selectOption('sections/actions.typ')
	assert.equal(
		await page.getByRole('combobox', { name: '源文件' }).inputValue(),
		'sections/analysis.typ',
	)
	assert.equal(
		await page.getByRole('textbox', { name: 'Typst 源码', exact: true }).inputValue(),
		'#upper("q4")',
	)
	await button('应用源码').click()
	await current()
	files = await sourceFiles()
	assert.match(files['sections/analysis.typ'], /#upper\("q4"\)/)
	assert.ok(files['sections/analysis.typ'].includes('#for name in'))
	checks.push('未知内联源节点显式修改，未知循环原文保留')
	checks.push('未应用源码阻止切换文件及下载旧PDF，草稿内容保留')

	await page.getByRole('button', { name: '数据：data/sales.json', exact: true }).first().click()
	const dataInput = page.getByRole('textbox', { name: 'JSON data/sales.json' })
	const data = JSON.parse(await dataInput.inputValue())
	const keys = Object.keys(data)
	assert.ok(keys.length)
	data.revenue = 144
	await dataInput.fill(JSON.stringify(data, null, 2))
	await button('保存 JSON').click()
	await current()
	const afterData = await sourceFiles()
	assert.equal(afterData['sections/analysis.typ'], files['sections/analysis.typ'])
	assert.equal(JSON.parse(afterData['data/sales.json']).revenue, 144)
	checks.push('JSON 数据控件修改实际文件，分析正文不变并重新编译')

	await button('源码').click()
	const source = page.getByRole('textbox', { name: '文件源码' })
	const valid = await source.inputValue()
	await source.fill(valid + '\n#let broken = (')
	await button('应用文件源码').click()
	await page.locator('.source-failure').waitFor({ timeout: 45000 })
	assert.match(await page.getByTestId('revision').textContent(), /旧预览/)
	const invalidFiles = await sourceFiles()
	assert.ok(invalidFiles['sections/analysis.typ'].endsWith('#let broken = ('))
	await source.fill(valid)
	await button('应用文件源码').click()
	await current()
	checks.push('错误源码可保存且旧预览标旧，修复恢复编译')

	await button('结构化编辑').click()
	await button('保存项目').click()
	await page.reload()
	await current()
	const reopenedFiles = await sourceFiles()
	assert.equal(reopenedFiles['sections/analysis.typ'], valid)
	assert.ok(
		await page
			.locator('.tiptap')
			.getByText('本季度营收增长，已核对中文合同与回款。', { exact: false })
			.count(),
	)
	checks.push('仅从保存源码重新打开并继续结构化显示')
	await page.screenshot({ path: resolve(output, 'desktop.png') })
	await page.setViewportSize({ width: 390, height: 844 })
	await page.screenshot({ path: resolve(output, 'mobile.png') })
	assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
	assert.deepEqual(errors, [])
	const requestOrder = await page.evaluate(async () => {
		const client = crypto.randomUUID()
		const headers = { 'Content-Type': 'application/json', 'X-Typst-Client': client }
		const compile = async (revision, sourceText) => {
			const response = await fetch('/compile', {
				method: 'POST',
				headers,
				body: JSON.stringify({ revision, files: { 'main.typ': sourceText } }),
			})
			return { status: response.status, value: await response.json() }
		}
		try {
			const latest = await compile(2, 'Latest accepted report.')
			const late = await compile(1, 'Stale late request.')
			const changedIdentity = await compile(2, 'Different snapshot at the same revision.')
			const pdf = await fetch('/pdf', {
				method: 'POST',
				headers,
				body: JSON.stringify({ revision: latest.value.preview.revision }),
			})
			const failure = await compile(3, '#let broken = (')
			const lateAfterFailure = await compile(2, 'Latest accepted report.')
			const repair = await compile(4, 'Repaired latest report.')
			return {
				latest: latest.status,
				late,
				changedIdentity,
				pdf: pdf.status,
				failure,
				lateAfterFailure,
				repair: repair.status,
			}
		} finally {
			await fetch('/session/close', { method: 'POST', headers, body: '{}' })
		}
	})
	assert.equal(requestOrder.latest, 200)
	assert.equal(requestOrder.pdf, 200)
	assert.equal(requestOrder.repair, 200)
	for (const result of [
		requestOrder.late,
		requestOrder.changedIdentity,
		requestOrder.lateAfterFailure,
	]) {
		assert.equal(result.status, 409)
		assert.equal(result.value.code, 'CONFLICT')
	}
	assert.equal(requestOrder.failure.value.code, 'COMPILE_FAILED')
	checks.push('真实HTTP拒绝迟到和同修订异内容快照，失败编译仍保留源码接纳顺序')
	await writeFile(resolve(output, 'results.json'), JSON.stringify({ checks, errors }, null, 2))
	console.log(JSON.stringify({ output, checks, errors }))
} catch (error) {
	const body = await page.locator('body').innerText()
	await page.screenshot({ path: resolve(output, 'failure.png'), fullPage: true })
	await writeFile(
		resolve(output, 'failure.json'),
		JSON.stringify(
			{
				checks,
				errors,
				failure: String(error),
				body: body.slice(0, 8000),
			},
			null,
			2,
		),
	)
	throw error
} finally {
	await release()
	await context.close()
	await browser.close()
}
