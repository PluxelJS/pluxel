import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright'
import { trackConsumerSessions } from './browser-session.mjs'
import { checkEditorPreviewFollowing, checkPreviewNavigation } from './preview-navigation.mjs'
import { checkSourceFileInput } from './source-file-check.mjs'
import { checkSourceControls } from './source-controls-check.mjs'
import { checkDefaultParameters } from './parameter-check.mjs'
import { checkFieldEditing } from './field-check.mjs'
import { checkApplicationForm } from './application-check.mjs'
import { assertWorkspaceFile, chooseWorkspaceFile, revealWorkspaceFile } from './workspace-ui.mjs'
import { checkWorkspace } from './workspace-check.mjs'

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
const context = await browser.newContext({
	viewport: { width: 1440, height: 1000 },
	colorScheme: 'light',
})
const page = await context.newPage()
const release = trackConsumerSessions(page)
const errors = [],
	checks = []
let firstCompile
page.on('response', (response) => {
	if (new URL(response.url()).pathname === '/compile' && response.ok() && !firstCompile)
		firstCompile = response.json()
})
page.on('pageerror', (error) => errors.push(String(error)))
const button = (name) => page.getByRole('button', { name, exact: true })
const sourceFiles = async () => {
	await button('保存项目').click()
	return page.evaluate(() => JSON.parse(localStorage.getItem('typst-source-project-v2')))
}
const current = async () => {
	await page
		.locator('.preview-pane[data-folder="report"]')
		.getByRole('button', { name: '下载 PDF', exact: true, includeHidden: true })
		.waitFor({ state: 'attached', timeout: 45000 })
	await page.waitForFunction(
		() =>
			![...document.querySelectorAll('.preview-pane[data-folder="report"] button')].find(
				(element) => element.textContent === '下载 PDF',
			)?.disabled,
		undefined,
		{ timeout: 45000 },
	)
	assert.deepEqual(await page.locator('.source-failure').allTextContents(), [])
}
const checkBlockGutter = async () => {
	const paragraph = page
		.locator('.workspace-panel:visible .tiptap p')
		.filter({ hasText: '本季度营收增长' })
		.first()
	await paragraph.click({ position: { x: 5, y: 10 } })
	await page.mouse.move(1, 1)
	await page.waitForFunction(() =>
		[...document.querySelectorAll('.typst-block-current, .typst-block-drag')].some(
			(element) =>
				getComputedStyle(element).visibility === 'visible' &&
				element.getBoundingClientRect().width > 0,
		),
	)
	const geometry = await paragraph.evaluate((element) => ({
		textLeft: element.getBoundingClientRect().left,
		controls: [...document.querySelectorAll('.typst-block-current, .typst-block-drag')]
			.filter(
				(control) =>
					getComputedStyle(control).visibility === 'visible' &&
					control.getBoundingClientRect().width > 0,
			)
			.map((control) => control.getBoundingClientRect().right),
	}))
	assert.ok(
		geometry.controls.every((right) => right <= geometry.textLeft + 0.5),
		JSON.stringify(geometry),
	)
}
const selectText = async (targetText, atEnd = false) => {
	await page.locator('.workspace-panel:visible .tiptap').evaluate(
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
// Check the actual rendered foreground/background, including transparent ancestors.
const checkTheme = async (scheme, selectors) => {
	const samples = await page.evaluate((targets) => {
		const canvas = document.createElement('canvas')
		canvas.width = canvas.height = 1
		const painter = canvas.getContext('2d', { willReadFrequently: true })
		const rgba = (color) => {
			painter.clearRect(0, 0, 1, 1)
			painter.fillStyle = color
			painter.fillRect(0, 0, 1, 1)
			return [...painter.getImageData(0, 0, 1, 1).data].map((value) => value / 255)
		}
		const blend = (top, bottom) =>
			top.slice(0, 3).map((value, index) => value * top[3] + bottom[index] * (1 - top[3]))
		const luminance = (rgb) =>
			rgb.reduce((sum, value, index) => {
				const linear = value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
				return sum + linear * [0.2126, 0.7152, 0.0722][index]
			}, 0)
		return targets.map((selector) => {
			const element = [...document.querySelectorAll(selector)].find(
				(candidate) =>
					candidate.getClientRects().length > 0 &&
					getComputedStyle(candidate).visibility !== 'hidden',
			)
			if (!element) throw new Error(`Theme sample missing: ${selector}`)
			const ancestors = []
			for (let ancestor = element; ancestor; ancestor = ancestor.parentElement)
				ancestors.unshift(ancestor)
			const background = ancestors.reduce(
				(value, ancestor) => blend(rgba(getComputedStyle(ancestor).backgroundColor), value),
				[1, 1, 1],
			)
			const back = luminance(background)
			const fore = luminance(blend(rgba(getComputedStyle(element).color), background))
			return {
				selector,
				background: back,
				contrast: (Math.max(fore, back) + 0.05) / (Math.min(fore, back) + 0.05),
			}
		})
	}, selectors)
	for (const sample of samples) {
		assert.ok(sample.contrast >= 4.5, `${scheme}: ${JSON.stringify(sample)}`)
		assert.equal(sample.background < 0.1, scheme === 'dark', `${scheme}: ${sample.selector}`)
	}
}
try {
	await page.goto(process.env.PLUXEL_TYPST_URL ?? 'http://127.0.0.1:3410')
	await current()
	const seedFiles = await sourceFiles()
	assert.ok(firstCompile, 'The real preview compiler response must be observed')
	const initialCompile = await firstCompile
	checks.push(...(await checkPreviewNavigation(page, seedFiles, initialCompile.preview)))
	checks.push(...(await checkEditorPreviewFollowing(page, seedFiles, initialCompile.preview)))
	checks.push(...(await checkSourceFileInput(page, seedFiles)))
	checks.push(...(await checkSourceControls(page, seedFiles)))
	checks.push(...(await checkDefaultParameters(page, output)))
	checks.push(...(await checkFieldEditing(page, output)))
	await checkBlockGutter()
	await page.screenshot({ path: resolve(output, 'desktop-following.png') })
	await page.getByRole('button', { name: '../lib/pluxel.typ', exact: true }).click()
	await page.waitForFunction(
		(expected) =>
			[...document.querySelectorAll('.workspace-panel textarea[aria-label="文件源码"]')].find(
				(element) => element.getClientRects().length > 0,
			)?.value === expected,
		seedFiles['lib/pluxel.typ'],
	)
	await assertWorkspaceFile(page, 'lib/pluxel.typ')
	assert.equal(await page.locator('.workspace-panel:visible .file-access').textContent(), '只读')
	assert.equal(await page.getByRole('textbox', { name: '文件源码' }).isEditable(), false)
	await chooseWorkspaceFile(page, 'assets/brand.svg')
	assert.equal(await page.locator('.workspace-panel:visible .file-access').textContent(), '只读')
	assert.equal(await page.getByRole('textbox', { name: '文件源码' }).isEditable(), false)
	await chooseWorkspaceFile(page, 'sections/analysis.typ')
	checks.push('库文件和项目资源通过实际树路径打开，显示各自只读状态')
	assert.equal(await page.locator('.workspace-panel:visible .typst-import').count(), 2)
	await page
		.locator('.workspace-panel:visible .typst-import')
		.nth(1)
		.getByRole('button', { name: '导入设置' })
		.click()
	await page.getByRole('textbox', { name: '导入成员' }).fill('revenue-chart, metrics')
	assert.equal(await button('下载 PDF').isDisabled(), true)
	await button('应用导入').click()
	await current()
	const importFiles = await sourceFiles()
	assert.equal(
		importFiles['sections/analysis.typ'],
		seedFiles['sections/analysis.typ'].replace('metrics, revenue-chart', 'revenue-chart, metrics'),
	)
	await page
		.locator('.workspace-panel:visible .typst-editor')
		.getByRole('button', { name: '撤销', exact: true })
		.click()
	await current()
	assert.deepEqual(await sourceFiles(), seedFiles)
	await page.getByRole('button', { name: '../components/blocks.typ', exact: true }).click()
	await assertWorkspaceFile(page, 'components/blocks.typ')
	await page.waitForFunction(
		(expected) =>
			[...document.querySelectorAll('.workspace-panel textarea[aria-label="文件源码"]')].find(
				(element) => element.getClientRects().length > 0,
			)?.value === expected,
		seedFiles['components/blocks.typ'],
	)
	assert.equal(await page.getByRole('textbox', { name: '文件源码' }).getAttribute('readonly'), '')
	await chooseWorkspaceFile(page, 'sections/analysis.typ')
	checks.push('原生导入可编辑成员、项目撤销恢复字节，并直接打开真实模块')
	await chooseWorkspaceFile(page, 'main.typ')
	await button('源码').click()
	assert.equal(await page.getByRole('textbox', { name: '文件源码' }).getAttribute('readonly'), '')
	assert.equal(await button('应用文件源码').isDisabled(), true)
	await button('结构化视图').click()
	assert.equal(
		await page.locator('.workspace-panel:visible .tiptap').getAttribute('contenteditable'),
		'false',
	)
	assert.equal(
		await page
			.locator('.workspace-panel:visible .typst-component')
			.getByRole('button', { name: '编辑参数' })
			.isDisabled(),
		true,
	)
	await page.screenshot({ path: resolve(output, 'fixed-template.png') })
	await page.getByRole('button', { name: '数据：data/sales.json', exact: true }).first().click()
	const fixedData = page.getByRole('textbox', { name: 'JSON data/sales.json' })
	assert.equal(await fixedData.isEditable(), true)
	const shared = JSON.parse(await fixedData.inputValue())
	shared.company = '北辰软件（共享字段核验）'
	await fixedData.fill(JSON.stringify(shared, null, 2))
	await button('保存 JSON').click()
	await current()
	let designFiles = await sourceFiles()
	assert.equal(designFiles['main.typ'], seedFiles['main.typ'])
	assert.equal(designFiles['sections/analysis.typ'], seedFiles['sections/analysis.typ'])
	assert.equal(JSON.parse(designFiles['data/sales.json']).company, shared.company)
	checks.push('固定模板结构只读，其数据控件仍可更新独立可写JSON')

	await chooseWorkspaceFile(page, 'sections/analysis.typ')
	assert.ok(
		await page
			.locator('.workspace-panel:visible .typst-source-field')
			.filter({ hasText: shared.company })
			.count(),
	)
	const bodyHeight = await page
		.locator('.workspace-panel:visible .tiptap')
		.evaluate((element) => element.scrollHeight)
	await page
		.locator('.workspace-panel:visible .typst-source-field')
		.getByRole('button', { name: shared.company, exact: true })
		.click()
	assert.equal(
		await page
			.locator('.workspace-panel:visible .tiptap')
			.evaluate((element) => element.scrollHeight),
		bodyHeight,
	)
	assert.equal(await button('保存 JSON').isDisabled(), true)
	const companyField = page.getByRole('textbox', { name: '字段值 company' })
	await companyField.fill('应被取消的字段草稿')
	await companyField.press('Escape')
	assert.equal(await page.getByRole('dialog').count(), 0)
	assert.deepEqual(await sourceFiles(), designFiles)
	await page
		.locator('.workspace-panel:visible .typst-source-field')
		.getByRole('button', { name: shared.company, exact: true })
		.click()
	await companyField.fill('')
	await companyField.press('Control+Enter')
	await current()
	await page
		.locator('.workspace-panel:visible .typst-source-field')
		.getByRole('button', { name: '未填写', exact: true })
		.click()
	await page.getByRole('textbox', { name: '字段值 company' }).fill(shared.company)
	await button('保存 JSON').click()
	await current()
	checks.push('空值字段保留可见入口，可在正文中重新填写并写回JSON')
	checks.push('字段浮层不改变正文布局，Escape取消不改文件，Ctrl+Enter应用普通业务值')
	await page
		.locator('.workspace-panel:visible .typst-component')
		.first()
		.getByRole('button', { name: '编辑参数' })
		.click()
	await page.getByRole('textbox', { name: '指标卡标题' }).fill('正文自定义指标')
	await page.getByRole('combobox', { name: '指标卡底色' }).selectOption('#effaf3')
	assert.equal(await button('下载 PDF').isDisabled(), true)
	await button('应用参数').click()
	await current()
	designFiles = await sourceFiles()
	assert.match(designFiles['sections/analysis.typ'], /title: "正文自定义指标"/)
	assert.match(designFiles['sections/analysis.typ'], /accent: "#effaf3"/)
	assert.equal(designFiles['main.typ'], seedFiles['main.typ'])
	assert.deepEqual(JSON.parse(designFiles['data/sales.json']), shared)
	checks.push('外部参数表单只修改正文组件实例，固定模板实例和业务数据不变')
	await page
		.locator('.workspace-panel:visible .typst-component')
		.first()
		.getByRole('button', { name: '编辑参数' })
		.click()
	await page.getByRole('combobox', { name: '指标卡底色' }).selectOption('')
	await button('应用参数').click()
	await current()
	designFiles = await sourceFiles()
	assert.doesNotMatch(designFiles['sections/analysis.typ'], /accent:/)
	checks.push('自定义组件可恢复默认参数，继续由普通源码编译')
	const beforeDelete = await sourceFiles()
	await page.locator('.workspace-panel:visible .tiptap').evaluate((element) => {
		const editor = element.editor
		let at
		editor.state.doc.descendants((node, position) => {
			if (node.type.name === 'typstField' && node.attrs.path.join('.') === 'company') at = position
		})
		if (at === undefined) throw new Error('Expected company field reference')
		editor.commands.setNodeSelection(at)
		editor.commands.deleteSelection()
	})
	await current()
	const afterDelete = await sourceFiles()
	assert.equal(afterDelete['data/sales.json'], beforeDelete['data/sales.json'])
	assert.equal(afterDelete['main.typ'], beforeDelete['main.typ'])
	assert.doesNotMatch(afterDelete['sections/analysis.typ'], /\("company",\)/)
	await page
		.locator('.workspace-panel:visible .tiptap')
		.evaluate((element) => element.editor.commands.undo())
	await current()
	assert.deepEqual(await sourceFiles(), beforeDelete)
	checks.push('删除和撤销行内字段引用不修改共享业务数据或固定模板')

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
	await chooseWorkspaceFile(page, 'sections/actions.typ')
	assert.equal(await page.getByRole('tab', { name: 'analysis.typ', exact: true }).count(), 1)
	assert.equal(await button('下载 PDF').isDisabled(), true)
	await page.getByRole('tab', { name: 'analysis.typ', exact: true }).click()
	await assertWorkspaceFile(page, 'sections/analysis.typ')
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
	checks.push('未应用源码随原生标签保留，树切其他文件与返回不丢草稿，项目 PDF 仍阻止下载')

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
	assert.match(
		await page.locator('.preview-pane:visible').getByTestId('revision').textContent(),
		/旧预览/,
	)
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
			.locator('.workspace-panel:visible .tiptap')
			.getByText('本季度营收增长，已核对中文合同与回款。', { exact: false })
			.count(),
	)
	checks.push('仅从保存源码重新打开并继续结构化显示')
	await page.screenshot({ path: resolve(output, 'desktop.png') })
	await page
		.locator('.workspace-panel:visible .typst-component')
		.first()
		.getByRole('button', { name: '编辑参数' })
		.click()
	await page.screenshot({ path: resolve(output, 'component-parameters.png') })
	await button('取消').click()
	await checkBlockGutter()
	checks.push('桌面块操作按钮位于正文左侧，不覆盖段首文字')
	for (const scheme of ['dark', 'light']) {
		await page.setViewportSize({ width: 1440, height: 1000 })
		await page.emulateMedia({ colorScheme: scheme })
		await revealWorkspaceFile(page, 'sections/analysis.typ')
		await page.locator('.workspace-panel:visible .typst-editor-content').evaluate((element) => {
			element.scrollTop = 0
		})
		await checkTheme(scheme, [
			':root',
			'[role="treeitem"][aria-selected="true"]',
			'.active-file',
			'.typst-editor',
			'.typst-source-card',
			'.typst-inline-source > button',
			'.typst-source-field button',
			'.typst-component-kind',
			'.typst-import-binding',
		])
		assert.equal(
			await page
				.locator('.preview-pane:visible .preview-scroll svg')
				.first()
				.evaluate((svg) => getComputedStyle(svg).backgroundColor),
			'rgb(255, 255, 255)',
		)
		await page.screenshot({ path: resolve(output, `${scheme}-desktop.png`) })
		await page
			.locator('.workspace-panel:visible .typst-component')
			.first()
			.getByRole('button', { name: '编辑参数' })
			.click()
		await checkTheme(scheme, [
			'.metrics-parameters',
			'.typst-node-panel-description',
			'.metrics-parameters input',
			'.metrics-parameters select',
		])
		await page.screenshot({ path: resolve(output, `${scheme}-parameters.png`) })
		await button('取消').click()
		await page.locator('.workspace-panel:visible .typst-source-field button').first().click()
		await checkTheme(scheme, ['.typst-binding-controls input'])
		await page.screenshot({ path: resolve(output, `${scheme}-json.png`) })
		await button('取消').click()
		await page
			.locator('.workspace-panel:visible .typst-import')
			.first()
			.getByRole('button', { name: '导入设置' })
			.click()
		await checkTheme(scheme, [
			'.typst-node-panel',
			'.typst-node-panel input',
			'.typst-node-panel select',
		])
		await page.screenshot({ path: resolve(output, `${scheme}-import.png`) })
		await button('取消').click()
		await button('源码').click()
		await checkTheme(scheme, ['.input-panel textarea'])
		await page.screenshot({ path: resolve(output, `${scheme}-source.png`) })
		await chooseWorkspaceFile(page, 'main.typ')
		await button('源码').click()
		await page.waitForFunction(
			(expected) =>
				[...document.querySelectorAll('.workspace-panel textarea[aria-label="文件源码"]')].find(
					(element) => element.getClientRects().length > 0,
				)?.value === expected,
			seedFiles['main.typ'],
		)
		await checkTheme(scheme, ['.file-access', '.input-panel textarea[readonly]'])
		await page.screenshot({ path: resolve(output, `${scheme}-template.png`) })
		await chooseWorkspaceFile(page, 'sections/analysis.typ')
		await button('结构化编辑').click()
		await page
			.locator('.workspace-panel:visible .typst-component')
			.first()
			.getByRole('button', { name: '编辑参数' })
			.click()
		await page.waitForFunction(() => {
			const bounds = document.querySelector('.typst-node-panel')?.getBoundingClientRect()
			return (
				bounds &&
				bounds.left >= 0 &&
				bounds.right <= innerWidth &&
				bounds.top >= 0 &&
				bounds.bottom <= innerHeight
			)
		})
		await page.screenshot({ path: resolve(output, `${scheme}-controls.png`) })
		await button('取消').click()
		checks.push(`${scheme}主题：页面、源码、字段和表单文字对比度≥4.5，预览保留白纸`)
	}
	await page.setViewportSize({ width: 1440, height: 1000 })
	for (const scheme of ['dark', 'light']) {
		await page.emulateMedia({ colorScheme: scheme === 'dark' ? 'light' : 'dark' })
		await page.evaluate((explicitScheme) => {
			document.documentElement.style.colorScheme = explicitScheme
		}, scheme)
		await checkTheme(scheme, [':root', '.typst-editor', '.typst-source-field button'])
	}
	checks.push('宿主显式主题覆盖系统偏好，编辑器与页面同步且无需重载')
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
	checks.push(...(await checkApplicationForm(page, output)))
	checks.push(...(await checkWorkspace(page, output, checkTheme)))
	assert.deepEqual(errors, [])
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
