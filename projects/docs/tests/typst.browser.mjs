import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { parseArgs } from 'node:util'
import { chromium } from 'playwright'

const { values } = parseArgs({
	options: {
		url: { type: 'string' },
		ws: { type: 'string' },
		artifacts: { type: 'string', default: '/tmp/pluxel-typst-browser' },
	},
})
if (!values.url) throw new Error('Pass --url with the running docs /examples URL.')
const artifacts = resolve(values.artifacts)
await mkdir(artifacts, { recursive: true })
const endpoint = values.ws ?? process.env.PLAYWRIGHT_WS_ENDPOINT ?? 'ws://127.0.0.1:3000'
const browser = await chromium.connect(endpoint, { exposeNetwork: '<loopback>' })
/** @type {import('playwright').BrowserContext | undefined} */
let context
/** @type {import('playwright').Page | undefined} */
let failurePage
/** @type {string[]} */
const errors = []
/** @type {string[]} */
const consoleErrors = []
/** @type {Set<import('playwright').Request>} */
const pendingRequests = new Set()
/** @type {string[]} */
const failedRequests = []
try {
	context = await browser.newContext({
		viewport: { width: 1440, height: 900 },
		colorScheme: 'light',
	})
	const wasmPattern = /\.wasm(?:\?|$)/
	let delayedWasmRequests = 0
	/** @param {import('playwright').Route} route */
	async function delayWasm(route) {
		const url = new URL(route.request().url())
		// Vite's ?import&url module is JavaScript; delay only the WASM binary fetch.
		if (
			url.pathname.endsWith('.wasm') &&
			!url.searchParams.has('import') &&
			!url.searchParams.has('url')
		) {
			delayedWasmRequests += 1
			await delay(2_000)
		}
		await route.continue()
	}
	await context.route(wasmPattern, delayWasm)
	const page = await context.newPage()
	failurePage = page
	/** @type {{ url: string, method: string }[]} */
	const requests = []
	/** @type {import('playwright').Worker[]} */
	const workers = []
	page.on('pageerror', (error) => errors.push(error.message))
	page.on('console', (message) => {
		if (message.type() === 'error') consoleErrors.push(message.text())
	})
	page.on('worker', (worker) => workers.push(worker))
	context.on('request', (request) => {
		pendingRequests.add(request)
		requests.push({ url: request.url(), method: request.method() })
	})
	context.on('requestfinished', (request) => pendingRequests.delete(request))
	context.on('requestfailed', (request) => {
		pendingRequests.delete(request)
		failedRequests.push(`${request.url()}: ${request.failure()?.errorText}`)
	})
	await page.goto(values.url, { waitUntil: 'domcontentloaded' })
	const editor = page.getByRole('textbox', {
		name: 'Typst 源文件 main.typ',
		exact: true,
		includeHidden: true,
	})
	await editor.waitFor()
	const examplesNav = page.getByRole('navigation', { name: '示例列表', exact: true })
	const typstExample = examplesNav.getByRole('button', { name: 'Typst 实时排版', exact: true })
	const hmrExample = examplesNav.getByRole('button', { name: '插件热替换', exact: true })
	const runtimeDetails = page.locator('details.typst-example-runtime')
	const editorPane = page.getByRole('region', { name: 'Typst 编辑器', exact: true })
	const hmrPane = page.getByRole('region', { name: '插件热替换演示', exact: true })
	assert.equal(await typstExample.getAttribute('aria-current'), 'page')
	assert.equal(await hmrPane.isVisible(), false, 'The default example shows the Typst editor.')
	assert.equal(await runtimeDetails.getAttribute('open'), null, 'Runtime logs start collapsed.')

	async function checkExampleEntrances() {
		const viewport = page.viewportSize()
		assert.ok(viewport)
		for (const entrance of [typstExample, hmrExample]) {
			const bounds = await entrance.boundingBox()
			assert.ok(bounds)
			assert.ok(
				bounds.x >= 0 &&
					bounds.y >= 0 &&
					bounds.x + bounds.width <= viewport.width &&
					bounds.y + bounds.height <= viewport.height,
				'Both example entrances remain visible in the viewport.',
			)
		}
	}
	await checkExampleEntrances()
	const editorBounds = await editorPane.boundingBox()
	assert.ok(editorBounds && editorBounds.y < 180, 'The editor starts near the top of the page.')
	assert.ok(editorBounds.height > 900 * 0.6, 'The editor occupies most of the desktop viewport.')
	assert.ok(
		await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 2),
		'The desktop example fits one viewport.',
	)
	const examplesLink = page.getByRole('link', { name: 'Examples', exact: true })
	const playgroundLink = page.getByRole('link', { name: '配置 Playground', exact: true })
	const examplesBounds = await examplesLink.boundingBox()
	const playgroundBounds = await playgroundLink.boundingBox()
	assert.ok(examplesBounds && playgroundBounds)
	assert.ok(
		examplesBounds.x > playgroundBounds.x && examplesBounds.y < 80,
		'The top navigation places Examples after Playground.',
	)
	assert.ok((await examplesLink.locator('svg').count()) > 0, 'Examples has a navigation icon.')
	await page.getByRole('toolbar', { name: '正文格式', exact: true }).waitFor()
	await page.getByRole('button', { name: '格式', exact: true }).waitFor()
	await page.getByRole('button', { name: '加粗', exact: true }).waitFor()
	assert.equal(await editor.locator('h1').innerText(), 'Pluxel × Typst')
	assert.equal(
		await page
			.getByRole('combobox', { name: '段落样式' })
			.locator('option[value="heading-1"]')
			.count(),
		1,
		'The shared editor exposes heading styles.',
	)
	assert.equal(
		await editor.locator('table tr').count(),
		3,
		'The shared editor contains a real table.',
	)
	const preview = page.frameLocator('iframe[title="Typst 排版结果"]')
	const status = page.locator('.typst-example-toolbar [role="status"]')
	const paragraphLink = preview.locator('a[aria-label="返回正文：正文 2"]').first()

	/** @param {string | null} [previousBlock] */
	async function waitCurrent(previousBlock) {
		await status.filter({ hasText: '运行中 · 自动编译' }).waitFor({ timeout: 65_000 })
		await preview.locator('a[aria-disabled="false"]').first().waitFor()
		if (previousBlock) {
			await preview
				.locator(`a[aria-label="返回正文：正文 2"]:not([data-editor-block="${previousBlock}"])`)
				.first()
				.waitFor()
		}
		return paragraphLink.getAttribute('data-editor-block')
	}

	await waitCurrent()
	await context.unroute(wasmPattern, delayWasm)
	assert.ok(
		delayedWasmRequests > 0,
		'Cold startup tolerates a real WASM fetch delayed beyond 1.5 seconds.',
	)
	assert.ok(
		(await preview.locator('svg path').count()) > 30,
		'The Chinese example renders glyph paths.',
	)
	const assets = () =>
		requests.filter((request) => /\.wasm(?:\?|$)|LXGWWenKai-Regular[^/]*\.ttf/.test(request.url))
	assert.ok(assets().length >= 3, 'Compiler, renderer, and font assets are requested.')
	for (const request of assets()) {
		assert.equal(new URL(request.url).origin, new URL(values.url).origin)
		assert.equal(request.method, 'GET')
	}
	// Development effects may mount twice; the ready runtime must own one live Worker.
	assert.equal(page.workers().length, 1, 'The ready example owns one live compiler Worker.')
	const originalWorker = page.workers()[0]
	const startupWorkerCount = workers.length
	const originalAssetCount = assets().length
	/** @param {'typst' | 'hmr'} example */
	async function showExample(example) {
		const entrance = example === 'typst' ? typstExample : hmrExample
		await entrance.click()
		await examplesNav
			.locator('button[aria-current="page"]')
			.filter({
				hasText: example === 'typst' ? 'Typst 实时排版' : '插件热替换',
			})
			.waitFor()
		await (example === 'typst' ? editorPane : hmrPane).waitFor()
		await checkExampleEntrances()
		assert.deepEqual(
			page.workers(),
			[originalWorker],
			'Switching examples retains the live Worker.',
		)
		assert.equal(workers.length, startupWorkerCount, 'Switching examples creates no new Worker.')
	}
	async function openRuntimeLog() {
		if ((await runtimeDetails.getAttribute('open')) === null) {
			await runtimeDetails.locator('summary').click()
		}
	}

	await context.setOffline(true)
	const navigation = page.locator('.typst-example-navigation')
	const paragraphText = '这份文档在你的浏览器中完成排版。'
	const paragraph = editor.locator('p').filter({ hasText: paragraphText })

	/** @param {import('playwright').Locator} node @param {string} label */
	async function selectEditorBlock(node, label) {
		await node.click()
		await navigation.filter({ hasText: `正文 → 预览：${label}` }).waitFor()
		const selected = preview.locator(`a[data-selected][aria-label="返回正文：${label}"]`).first()
		await selected.waitFor()
		const id = await selected.getAttribute('data-editor-block')
		assert.ok(id, 'The highlighted preview belongs to a compiled editor block.')
		return id
	}

	/** @param {string} label @param {string} text @param {string} [tag] */
	async function selectPreviewBlock(label, text, tag = 'p') {
		// Exercise actual SVG hit geometry, not a synthetic message or editor command.
		await preview
			.getByRole('button', { name: `返回正文：${label}`, exact: true })
			.first()
			.locator('rect')
			.first()
			.click()
		await navigation.filter({ hasText: `预览 → 正文：${label}` }).waitFor()
		await editor.waitFor()
		assert.equal(
			await typstExample.getAttribute('aria-current'),
			'page',
			'Preview navigation opens the Typst example.',
		)
		await page.waitForFunction(
			(expected) => {
				const root = document.querySelector('[aria-label="Typst 源文件 main.typ"]')
				const selection = document.getSelection()
				const node = selection?.anchorNode
				const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement
				return (
					root?.contains(document.activeElement) &&
					node &&
					root.contains(node) &&
					element instanceof Element &&
					element.closest(expected.tag)?.textContent?.includes(expected.text)
				)
			},
			{ text, tag },
		)
	}

	const originalBlock = await selectEditorBlock(paragraph, '正文 2')
	await page.getByRole('tab', { name: 'Typst 源码', exact: true }).click()
	await selectPreviewBlock('正文 2', paragraphText)
	assert.equal(
		await page.getByRole('tab', { name: '正文编辑器', exact: true }).getAttribute('aria-selected'),
		'true',
		'Preview navigation opens the rich editor.',
	)
	await selectEditorBlock(
		editor.getByRole('cell', { name: '浏览器 Worker', exact: true }),
		'表格 6',
	)
	await selectPreviewBlock('表格 6', '运行位置', 'table')

	await paragraph.click()
	await page.keyboard.press('End')
	await page.keyboard.insertText(' 离线富文本修改。')
	assert.match(await paragraph.innerText(), /离线富文本修改/)
	await waitCurrent(originalBlock)
	const updatedBlock = await selectEditorBlock(paragraph, '正文 2')
	assert.notEqual(
		updatedBlock,
		originalBlock,
		'Recompilation replaces the old revision’s navigation.',
	)
	await selectPreviewBlock('正文 2', '离线富文本修改')

	const theme = page.getByRole('combobox', { name: '热替换排版插件', exact: true })
	const updateReport = page.getByLabel('热替换结果', { exact: true })
	const runtimeLog = page.getByRole('list', { name: '运行记录', exact: true })
	async function generation() {
		await openRuntimeLog()
		const log = await runtimeLog.innerText()
		const matches = [...log.matchAll(/ReportPlugin #(\d+) · 编译完成/g)]
		assert.ok(matches.length, 'A real ReportPlugin instance reports compilation.')
		return Number(matches.at(-1)?.[1])
	}
	async function paint() {
		return preview
			.locator('svg')
			.evaluate((svg) =>
				[...svg.querySelectorAll('[fill], [stroke]')]
					.map((node) => `${node.getAttribute('fill')}:${node.getAttribute('stroke')}`)
					.join('\n'),
			)
	}
	await showExample('hmr')
	assert.equal(await editor.isVisible(), false, 'The inactive editor stays mounted but hidden.')
	assert.notEqual(
		await runtimeDetails.getAttribute('open'),
		null,
		'The HMR example opens runtime logs.',
	)
	let catalogRevision = 0
	let reportGeneration = await generation()
	/** @param {'classic' | 'color'} value */
	async function replaceTheme(value) {
		await theme.selectOption(value)
		await page.waitForFunction((previousRevision) => {
			const report = document.querySelector('[aria-label="热替换结果"]')?.textContent ?? ''
			return Number(/目录 #(\d+)/.exec(report)?.[1]) > previousRevision
		}, catalogRevision)
		await waitCurrent()
		const report = await updateReport.innerText()
		assert.match(report, /替换：\s*ThemePlugin/)
		assert.match(report, /重启：\s*ReportPlugin/)
		assert.match(report, /保留：\s*TypstPlugin/)
		catalogRevision = Number(/目录 #(\d+)/.exec(report)?.[1])
		const nextGeneration = await generation()
		assert.ok(nextGeneration > reportGeneration, 'Replacing ThemePlugin restarts ReportPlugin.')
		reportGeneration = nextGeneration
		assert.deepEqual(page.workers(), [originalWorker], 'Hot replacement retains the live Worker.')
		assert.equal(
			workers.length,
			startupWorkerCount,
			'Hot replacement does not create another Worker.',
		)
		assert.equal(assets().length, originalAssetCount, 'Hot replacement reuses WASM and fonts.')
		assert.match(
			await paragraph.innerText(),
			/离线富文本修改/,
			'Hot replacement retains editor content.',
		)
	}

	const classicPaint = await paint()
	await replaceTheme('color')
	const colorPaint = await paint()
	assert.notEqual(colorPaint, classicPaint, 'The replacement changes the rendered SVG paint.')
	assert.match(colorPaint, /13795b|19,\s*121,\s*91/i)
	await page.screenshot({ path: resolve(artifacts, 'desktop-hmr.png'), animations: 'disabled' })
	await replaceTheme('classic')
	assert.equal(await paint(), classicPaint, 'Replacing back restores the original SVG paint.')
	await showExample('typst')
	assert.match(
		await paragraph.innerText(),
		/离线富文本修改/,
		'Switching examples preserves the document.',
	)
	await showExample('hmr')
	await selectPreviewBlock('正文 2', '离线富文本修改')
	await checkExampleEntrances()

	let previousBlock = await paragraphLink.getAttribute('data-editor-block')
	await page.getByRole('button', { name: '撤销', exact: true }).click()
	assert.equal(
		await paragraph.innerText(),
		paragraphText,
		'Example switches and plugin replacement retain undo history.',
	)
	await waitCurrent(previousBlock)
	previousBlock = await paragraphLink.getAttribute('data-editor-block')
	await page.getByRole('button', { name: '重做', exact: true }).click()
	assert.match(await paragraph.innerText(), /离线富文本修改/, 'Redo restores the edited document.')
	await waitCurrent(previousBlock)
	await selectPreviewBlock('正文 2', '离线富文本修改')
	await page.screenshot({ path: resolve(artifacts, 'desktop.png'), animations: 'disabled' })
	const themeToggle = page.locator('button[data-theme-toggle]:visible')
	await themeToggle.click()
	await page.locator('html.dark').waitFor()
	await page.screenshot({ path: resolve(artifacts, 'desktop-dark.png'), animations: 'disabled' })
	await themeToggle.click()
	await page.locator('html:not(.dark)').waitFor()

	await page.getByRole('tab', { name: 'Typst 源码', exact: true }).click()
	const source = page.getByLabel('main.typ', { exact: true })
	const originalTemplate = await source.inputValue()
	assert.match(originalTemplate, /width:\s*145mm/)
	const template = originalTemplate.replace(/width:\s*145mm/, 'width: 165mm')
	async function previewWidth() {
		return preview
			.locator('svg')
			.evaluate((svg) =>
				Number.parseFloat(
					svg.getAttribute('viewBox')?.trim().split(/\s+/)[2] ?? svg.getAttribute('width') ?? '',
				),
			)
	}
	const originalWidth = await previewWidth()
	assert.ok(Number.isFinite(originalWidth) && originalWidth > 0)
	previousBlock = await paragraphLink.getAttribute('data-editor-block')
	await source.fill(template)
	await waitCurrent(previousBlock)
	assert.ok(
		(await previewWidth()) > originalWidth,
		'Editing main.typ page width automatically produces a wider SVG while offline.',
	)
	previousBlock = await paragraphLink.getAttribute('data-editor-block')
	await source.fill('#let =')
	await page.locator('.typst-example-error[role="alert"]').waitFor()
	assert.match(
		await page.locator('.typst-example-error[role="alert"]').innerText(),
		/Typst compilation failed/,
	)
	assert.equal(await page.locator('iframe[title="Typst 排版结果"]').count(), 1)
	assert.equal(await paragraphLink.getAttribute('data-editor-block'), previousBlock)
	await navigation.filter({ hasText: '预览为上次结果，更新完成后恢复对照跳转。' }).waitFor()
	assert.equal(await preview.locator('a[data-editor-block]:not([aria-disabled="true"])').count(), 0)
	assert.equal(await preview.locator('a[data-editor-block]:not([tabindex="-1"])').count(), 0)
	assert.equal(await preview.locator('a[data-selected]').count(), 0)
	// Disabled SVG links cannot be clicked through Locator.click(); use their actual hit geometry.
	const staleRect = await paragraphLink.locator('rect').first().boundingBox()
	assert.ok(staleRect)
	await page.mouse.click(staleRect.x + staleRect.width / 2, staleRect.y + staleRect.height / 2)
	assert.equal(
		await page.getByRole('tab', { name: 'Typst 源码', exact: true }).getAttribute('aria-selected'),
		'true',
		'A stale preview cannot move the editor selection.',
	)
	await source.fill(`${template}\n// 离线模板恢复\n`)
	await waitCurrent(previousBlock)
	assert.ok(
		(await preview.locator('svg path').count()) > 10,
		'Offline recovery renders the corrected document.',
	)
	await page.getByRole('tab', { name: '正文编辑器', exact: true }).click()
	await selectPreviewBlock('正文 2', '离线富文本修改')
	assert.equal(
		assets().length,
		originalAssetCount,
		'Offline edits reuse the loaded compiler and font.',
	)
	await page.setViewportSize({ width: 390, height: 844 })
	await checkExampleEntrances()
	await showExample('hmr')
	await replaceTheme('color')
	await page.screenshot({ path: resolve(artifacts, 'mobile-hmr.png'), animations: 'disabled' })
	await selectPreviewBlock('正文 2', '离线富文本修改')
	await checkExampleEntrances()
	await page.screenshot({ path: resolve(artifacts, 'mobile.png'), animations: 'disabled' })
	assert.ok(
		await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
		'Mobile page does not overflow horizontally.',
	)
	await page.getByRole('button', { name: '停止', exact: true }).click()
	await page.getByRole('button', { name: '重新启动', exact: true }).waitFor()
	await openRuntimeLog()
	assert.match(
		await page.locator('.typst-example-runtime').innerText(),
		/Host 已关闭，Typst 资源已释放/,
	)
	await context.setOffline(false)
	await page.getByRole('button', { name: '重新启动', exact: true }).click()
	await waitCurrent()
	assert.equal(
		workers.length,
		startupWorkerCount + 1,
		'An explicit restart creates one new Worker.',
	)
	assert.notEqual(page.workers()[0], originalWorker)
	assert.match(await paragraph.innerText(), /离线富文本修改/, 'Restart preserves the document.')
	await page.getByRole('button', { name: '停止', exact: true }).click()
	await page.getByRole('button', { name: '重新启动', exact: true }).waitFor()
	assert.deepEqual(errors, [])
	assert.equal(
		requests.filter((request) => request.method !== 'GET').length,
		0,
		'Compilation does not submit source to a server.',
	)
	console.log(
		'PASS: delayed WASM cold startup, automatic compilation, real plugin replacement, Worker/WASM/font reuse, shared rich editor and undo, paragraph/table navigation, stale preview guard, offline error/recovery, stop/restart, desktop/mobile.',
	)
} catch (error) {
	console.error(
		JSON.stringify(
			{
				page: await failurePage
					?.locator('.typst-example')
					.innerText({ timeout: 1_000 })
					.catch(String),
				errors,
				consoleErrors,
				pendingRequests: [...pendingRequests].map((request) => request.url()),
				failedRequests,
			},
			null,
			2,
		),
	)
	await failurePage
		?.screenshot({ path: resolve(artifacts, 'failure.png'), fullPage: true })
		.catch(String)
	throw error
} finally {
	try {
		await context?.close()
	} finally {
		// For connect(), close() disconnects this client; it does not stop the shared browser server.
		await browser.close()
	}
}
