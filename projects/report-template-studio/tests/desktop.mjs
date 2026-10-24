import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { _electron as electron } from 'playwright'
import electronExecutable from 'electron'
import { rolldown } from 'rolldown'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const applicationRoot = resolve(process.env.STUDIO_APP_ROOT ?? root)
const clientEntry = createRequire(join(applicationRoot, 'package.json')).resolve(
	'@report-template-studio/app/client',
)
const { connectStudio, discoverStudio } = await import(pathToFileURL(clientEntry).href)
const output = resolve(process.env.STUDIO_SCREENSHOTS ?? join(root, 'test-results/desktop'))
const profile = await mkdtemp(join(tmpdir(), 'pluxel-workspace-desktop-'))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const errors = [],
	logs = []
let instance, processClosed, page, project, documentConfig, connection, studio, portEvidence
const executablePath = process.env.STUDIO_EXECUTABLE ?? electronExecutable
const ozonePlatform =
	process.env.STUDIO_OZONE_PLATFORM ?? (process.env.WAYLAND_DISPLAY ? 'wayland' : undefined)
const args = [
	...(process.env.STUDIO_EXECUTABLE ? [] : [applicationRoot]),
	`--user-data-dir=${profile}`,
	'--disable-gpu',
	...(process.platform === 'linux' && ozonePlatform ? [`--ozone-platform=${ozonePlatform}`] : []),
	...(process.env.STUDIO_DISABLE_SANDBOX === '1' ? ['--no-sandbox'] : []),
]
await mkdir(output, { recursive: true })
// A test-owned browser bundle loads the actual MessagePort adapter. The production
// renderer and utility process still use their ordinary port setup and RPC target.
const probeBuild = await rolldown({
	input: join(root, 'src/rpc/message-port.ts'),
	platform: 'browser',
})
const { output: probeChunks } = await probeBuild.generate({
	format: 'iife',
	name: 'StudioRpcProbe',
})
await probeBuild.close()
const probeBundle = probeChunks.find((chunk) => chunk.type === 'chunk' && chunk.isEntry)?.code
assert.ok(probeBundle)

async function start() {
	instance = await electron.launch({ executablePath, args, env, timeout: 90_000 })
	processClosed = once(instance.process(), 'close')
	instance.process().stderr?.on('data', (bytes) => logs.push(bytes.toString()))
	instance.process().stdout?.on('data', (bytes) => logs.push(bytes.toString()))
	page = await instance.firstWindow({ timeout: 90_000 })
	await instance.evaluate(({ BrowserWindow }) => {
		const window = BrowserWindow.getAllWindows()[0]
		window.unmaximize()
		window.setBounds({ x: 0, y: 0, width: 1440, height: 900 })
	})
	page.setDefaultTimeout(60_000)
	page.on('pageerror', (error) => {
		errors.push(error.message)
		logs.push(`PAGEERROR ${error.stack}\n`)
	})
	page.on('console', (message) => {
		if (message.type() === 'error') logs.push(`RENDERER ${message.text()}\n`)
	})
	await page.exposeFunction('studioFocusProbe', (event) =>
		logs.push(`INPUT ${JSON.stringify(event)}\n`),
	)
	await page.evaluate(() => {
		for (const type of ['focusin', 'pointerdown', 'keydown'])
			document.addEventListener(
				type,
				(event) => {
					void window.studioFocusProbe({
						type,
						tag: event.target?.tagName,
						label: event.target?.getAttribute?.('aria-label'),
						text:
							event.type === 'pointerdown' ? event.target?.textContent?.slice(0, 100) : undefined,
						key: event.key,
						ctrl: event.ctrlKey,
						trusted: event.isTrusted,
					})
				},
				true,
			)
	})
	page.on('dialog', (dialog) => {
		void dialog.accept().catch((error) => {
			if (!error.message.includes('No dialog is showing')) errors.push(error.message)
		})
	})
	await page.getByRole('button', { name: '新建项目', exact: true }).waitFor()
	await page.getByText('财务报表 Starter', { exact: true }).waitFor()
	await until(async () => {
		const discovered = await discoverStudio()
		const descriptor = discovered.find((item) => item.root === join(profile, 'studio'))
		if (!descriptor) return false
		connection = await connectStudio(descriptor)
		studio = connection.api
		return true
	}, 'The isolated desktop profile did not publish its public RPC instance')
	await page.evaluate(probeBundle)
	await page.evaluate(async () => {
		const port = await new Promise((accept) => {
			function receive(event) {
				if (
					event.source !== window ||
					event.data?.type !== 'studio:port' ||
					event.ports.length !== 1
				)
					return
				window.removeEventListener('message', receive)
				accept(event.ports[0])
			}
			window.addEventListener('message', receive)
			window.studio.connect()
		})
		window.studioProbe = window.StudioRpcProbe.createDesktopClient(port)
	})
}
async function closeInstance(destroyWindows = false) {
	if (!instance) return
	if (destroyWindows)
		await instance
			.evaluate(({ BrowserWindow }) => {
				for (const window of BrowserWindow.getAllWindows()) window.destroy()
			})
			.catch((error) => {
				if (!error.message.includes('Target page, context or browser has been closed')) throw error
			})
	// Destroying the last window already requests quit. Playwright requests it again;
	// both requests must wait for the same backend cleanup acknowledgement.
	await instance.close()
	const [code, signal] = await processClosed
	instance = undefined
	processClosed = undefined
	assert.equal(code, 0, 'The Electron process exits successfully after backend cleanup')
	assert.equal(signal, null, 'The Electron process exits without being killed')
	assert.doesNotMatch(
		logs.join(''),
		/Studio shutdown failed/,
		'Backend shutdown completes normally',
	)
}
const readText = (path) => studio.readFile({ projectId: project.id, path })
async function until(check, reason) {
	const deadline = Date.now() + 60_000
	while (Date.now() < deadline) {
		if (await check()) return
		await new Promise((done) => setTimeout(done, 100))
	}
	throw new Error(reason)
}
async function screenshot(name) {
	await page.screenshot({ path: join(output, `${name}.png`), animations: 'disabled' })
	if (name === '01-form-preview')
		await writeFile(
			join(output, 'scroll-layout.json'),
			JSON.stringify(
				await page.evaluate(() =>
					[...document.querySelectorAll('*')]
						.filter(
							(element) =>
								element.clientWidth &&
								(element.scrollWidth > element.clientWidth + 2 ||
									element.scrollHeight > element.clientHeight + 2),
						)
						.map((element) => ({
							tag: element.tagName,
							class: element.className,
							client: [element.clientWidth, element.clientHeight],
							scroll: [element.scrollWidth, element.scrollHeight],
							overflow: [getComputedStyle(element).overflowX, getComputedStyle(element).overflowY],
							display: getComputedStyle(element).display,
							height: getComputedStyle(element).height,
							parent: element.parentElement?.className,
						})),
				),
				null,
				2,
			),
		)
}
async function ready() {
	await page.locator('.typst-pages:visible svg').first().waitFor({ timeout: 90_000 })
	await until(
		async () => await page.getByRole('button', { name: '导出 PDF', exact: true }).isEnabled(),
		'Preview did not recover to exportable revision',
	)
	await page.locator('.document-preview[data-preview-current="true"]:visible').waitFor()
}
const treeItem = (path) =>
	page.getByRole('treeitem').and(page.locator(`[data-path=${JSON.stringify(path)}]`))
async function revealFile(path) {
	for (let index = 1; index < path.split('/').length; index++) {
		const ancestor = treeItem(path.split('/').slice(0, index).join('/'))
		if (
			(await ancestor.isVisible()) &&
			(await ancestor.getAttribute('aria-expanded')) === 'false'
		) {
			await ancestor.focus()
			await ancestor.press('ArrowRight')
		}
	}
}
async function openFile(path) {
	await revealFile(path)
	await treeItem(path).click()
	if (path === documentConfig.entry)
		await page
			.locator('[aria-label="报表编辑模式"]:visible')
			.getByText('入口代码', { exact: true })
			.click()
	await page.locator('.monaco-editor:visible textarea.inputarea').waitFor()
}
async function fileMenu(action, path) {
	if (path) {
		await revealFile(path)
		await treeItem(path).click({ button: 'right' })
	} else await page.getByRole('button', { name: '文件操作', exact: true }).click()
	await page
		.getByRole('menuitem')
		.filter({ has: page.getByText(action, { exact: true }) })
		.click()
}
async function projectMenu(action) {
	await page.getByRole('button', { name: '项目', exact: true }).click()
	await page.getByRole('menuitem', { name: action, exact: true }).click()
}
async function openAssistant() {
	await page.getByRole('button', { name: '显示 AI 助手', exact: true }).click()
	const composer = page.getByRole('textbox', { name: '发送给 AI 的消息', exact: true })
	const empty = page.getByText('新建会话，开始完善项目', { exact: true })
	await until(
		async () => (await composer.isVisible()) || (await empty.isVisible()),
		'Assistant did not display its composer or new-session state',
	)
	if (await empty.isVisible())
		await page.getByRole('button', { name: '新建 AI 会话', exact: true }).click()
	await composer.waitFor()
}

async function replaceCode(text) {
	const input = page.locator('.monaco-editor:visible textarea.inputarea')
	await input.focus()
	await input.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
	await input.evaluate((element, content) => {
		const clipboardData = new DataTransfer()
		clipboardData.setData('text/plain', content)
		element.dispatchEvent(
			new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }),
		)
	}, text)
}
async function completion(label) {
	const option = page.locator('.suggest-widget.visible').getByText(label, { exact: true })
	await until(async () => {
		if (await option.isVisible()) return true
		await page.locator('.monaco-editor:visible textarea.inputarea').focus()
		await page.keyboard.press('Control+Space')
		try {
			await option.waitFor({ timeout: 1500 })
			return true
		} catch {
			return false
		}
	}, `Missing language service completion ${label}`)
}
async function savePicker(path) {
	await instance.evaluate(({ dialog }, selected) => {
		dialog.showSaveDialog = async () => ({ canceled: false, filePath: selected })
	}, path)
}
async function importPicker(path) {
	await instance.evaluate(({ dialog }, selected) => {
		dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] })
	}, path)
}
async function completeFile(path, verify) {
	let result
	await until(async () => {
		try {
			result = await readFile(path)
			return verify(result)
		} catch (error) {
			if (error.code !== 'ENOENT') throw error
			return false
		}
	}, `Export not complete: ${path}`)
	return result
}
async function selectDocument(wait = true) {
	await revealFile(documentConfig.entry)
	await treeItem(documentConfig.entry).click()
	await page
		.locator('[aria-label="报表编辑模式"]:visible')
		.getByText('表单', { exact: true })
		.click()
	if (wait) await ready()
}

async function portError(methodName, inputValue) {
	return page.evaluate(
		async ({ method, input }) => {
			try {
				await window.studioProbe.api[method](input)
				return { unexpectedSuccess: true }
			} catch (error) {
				return {
					code: error.code,
					message: error.message,
					diagnostics: error.diagnostics,
					issues: error.issues,
				}
			}
		},
		{ method: methodName, input: inputValue },
	)
}
async function verifyPortBoundary(entry) {
	const requestedTarget = { projectId: project.id, entry }
	const before = await studio.getInput(requestedTarget)
	const binary = await page.evaluate(async (target) => {
		const api = window.studioProbe.api
		const compiled = await api.compile({ ...target, data: {}, clientRevision: 0 })
		const first = await api.getPreview({ ...target, revision: compiled.revision })
		const original = new Uint8Array(first.preview.data)
		const firstWasBinary = first.preview.data instanceof Uint8Array
		first.preview.data[0] ^= 1
		const second = await api.getPreview({ ...target, revision: compiled.revision })
		const third = await api.getPreview({ ...target, revision: compiled.revision })
		const same = (bytes) =>
			bytes instanceof Uint8Array &&
			bytes.byteLength === original.byteLength &&
			bytes.every((value, index) => value === original[index])
		return {
			revision: compiled.revision,
			byteLength: original.byteLength,
			firstWasBinary,
			secondMatches: same(second.preview.data),
			thirdMatches: same(third.preview.data),
			sessionId: second.preview.sessionId,
			nativeRevision: second.preview.revision,
			compilerVersion: second.preview.compilerVersion,
			pageCount: compiled.pageCount,
			outline: compiled.outline,
			point: second.preview.navigation?.points.find(
				(point) => point.path === compiled.template && point.line === 8,
			),
		}
	}, requestedTarget)
	assert.ok(
		binary.firstWasBinary && binary.secondMatches && binary.thirdMatches,
		'Real renderer → utility MessagePort preserves Uint8Array and the cached backend bytes',
	)
	assert.ok(binary.byteLength > 0)
	assert.ok(binary.sessionId && Number.isSafeInteger(binary.nativeRevision))
	assert.equal(binary.compilerVersion, '0.7.0')
	assert.ok(binary.pageCount > 1, 'The genuine renderer compiles the multi-page quarterly report')
	assert.ok(binary.outline.length > 1)
	assert.deepEqual(
		await studio.getInput(requestedTarget),
		before,
		'Explicit compile does not write stored form input',
	)
	const invalidJson = await portError('compile', requestedTarget)
	assert.equal(invalidJson.code, 'INVALID_INPUT')
	assert.ok(invalidJson.issues?.length)
	const schema = await portError('compile', {
		...requestedTarget,
		data: { company: 42 },
		clientRevision: 0,
	})
	assert.equal(schema.code, 'INVALID_INPUT')
	assert.ok(schema.issues?.some((issue) => issue.path.includes('company')))
	const pageError = await portError('renderPage', {
		...requestedTarget,
		revision: binary.revision,
		page: 0,
	})
	assert.equal(pageError.code, 'INVALID_INPUT')
	const cropError = await portError('renderPage', {
		...requestedTarget,
		revision: binary.revision,
		page: 1,
		region: { x: 0, y: 0, width: -1, height: 10 },
	})
	assert.equal(cropError.code, 'INVALID_INPUT')
	const newer = await page.evaluate(async (target) => {
		const compiled = await window.studioProbe.api.compile({
			...target,
			data: {},
			clientRevision: 0,
		})
		return { revision: compiled.revision }
	}, requestedTarget)
	assert.notEqual(
		newer.revision,
		binary.revision,
		'Identical input still receives a new public revision',
	)
	const conflict = await portError('getPreview', { ...requestedTarget, revision: binary.revision })
	assert.equal(conflict.code, 'REVISION_CONFLICT')
	const template = `${entry.slice(0, entry.lastIndexOf('/'))}/排版.typ`
	const originalTyp = await readText(template)
	let typst, typescript
	try {
		await studio.writeFile({
			projectId: project.id,
			path: template,
			content: '#let broken = (',
			expectedVersion: originalTyp.version,
		})
		typst = await portError('compile', { ...requestedTarget, data: {}, clientRevision: 0 })
		assert.equal(typst.code, 'COMPILE_FAILED')
		assert.ok(
			typst.diagnostics?.some((diagnostic) => diagnostic.path === template),
			'Native Typst diagnostics survive the actual port',
		)
	} finally {
		const changed = await readText(template)
		await studio.writeFile({
			projectId: project.id,
			path: template,
			content: originalTyp.content,
			expectedVersion: changed.version,
		})
	}
	const originalTs = await readText(entry)
	try {
		await studio.writeFile({
			projectId: project.id,
			path: entry,
			content: 'export default { broken:',
			expectedVersion: originalTs.version,
		})
		typescript = await portError('compile', { ...requestedTarget, data: {}, clientRevision: 0 })
		assert.equal(typescript.code, 'COMPILE_FAILED')
		assert.ok(
			typescript.diagnostics?.some((diagnostic) => diagnostic.path === entry),
			'TypeScript source diagnostics survive the actual port',
		)
	} finally {
		const changed = await readText(entry)
		await studio.writeFile({
			projectId: project.id,
			path: entry,
			content: originalTs.content,
			expectedVersion: changed.version,
		})
	}
	return {
		binary,
		errors: { invalidJson, schema, pageError, cropError, conflict, typst, typescript },
	}
}

async function verifyMultiPageUi(entry, binary) {
	await revealFile(entry)
	await treeItem(entry).click()
	await page.getByRole('button', { name: '刷新预览', exact: true }).click()
	await ready()
	const svgPages = page.locator('.typst-pages:visible .typst-page')
	assert.equal(await svgPages.count(), binary.pageCount)
	await page.getByRole('button', { name: '目录与页面', exact: true }).click()
	const navigation = page.getByRole('navigation', { name: '文档目录与页面', exact: true })
	await navigation.getByRole('button', { name: `第 ${binary.pageCount} 页`, exact: true }).click()
	assert.equal(
		await page.getByLabel('跳转到页', { exact: true }).filter({ visible: true }).inputValue(),
		String(binary.pageCount),
	)
	await screenshot('01-quarterly-last-page')
	await navigation.getByRole('button').filter({ hasText: '经营概况' }).click()
	assert.equal(
		await page.getByLabel('跳转到页', { exact: true }).filter({ visible: true }).inputValue(),
		String(binary.outline.find((heading) => heading.title === '经营概况').page),
	)
	await screenshot('01-quarterly-outline')
	assert.ok(binary.point, 'A real Typst source span is available for two-way navigation')
	const click = await svgPages.nth(binary.point.page - 1).evaluate((element, point) => {
		const matrix = element.getScreenCTM()
		const position = new DOMPoint(
			point.x + point.width / 2,
			point.y + point.height / 2,
		).matrixTransform(matrix)
		return { x: position.x, y: position.y }
	}, binary.point)
	await page.mouse.click(click.x, click.y)
	await page.locator('.monaco-editor:visible textarea.inputarea').waitFor()
	const sourceLine = page
		.locator('.monaco-editor:visible .view-line')
		.filter({ hasText: '= 经营概况' })
	await sourceLine.waitFor()
	await sourceLine.click({ position: { x: 42, y: 5 } })
	await page.locator('.preview-source-highlight:visible').waitFor()
	await screenshot('01-quarterly-source-navigation')
}

async function selectEditorText(editor, text, collapse = false) {
	await editor.evaluate(
		(element, input) => {
			element.focus()
			const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
			let node
			while ((node = walker.nextNode())) {
				const offset = node.textContent.indexOf(input.text)
				if (offset < 0) continue
				const range = document.createRange()
				range.setStart(node, offset)
				range.setEnd(node, offset + input.text.length)
				if (input.collapse) range.collapse(false)
				const selection = window.getSelection()
				selection.removeAllRanges()
				selection.addRange(range)
				return
			}
			throw new Error(`Editor text is missing: ${input.text}`)
		},
		{ text, collapse },
	)
	// Allow the native selectionchange to reach ProseMirror before clicking a toolbar button.
	await editor.evaluate(
		() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
	)
}

const bodyTypographyText = '中文输入验收𠮷'
const bodyTypography = {
	fontFamily: 'Noto Serif CJK SC',
	fontSize: '18pt',
	color: '#dc2626',
	backgroundColor: '#fef08a',
}

function typographyTextNode(input) {
	const find = (node) => {
		if (node?.type === 'text' && node.text.includes(bodyTypographyText)) return node
		for (const child of node?.content ?? []) {
			const found = find(child)
			if (found) return found
		}
	}
	return find(input.editor?.regions.summary)
}

function assertBodyTypography(input) {
	const node = typographyTextNode(input)
	assert.ok(node, 'Saved raw region retains the native composition text')
	const style = node.marks?.find((mark) => mark.type === 'textStyle')
	assert.ok(style, 'Saved raw region retains its textStyle mark')
	for (const [attribute, value] of Object.entries(bodyTypography))
		assert.equal(style.attrs[attribute], value)
	assert.ok(
		node.marks.some((mark) => mark.type === 'bold'),
		'Typography retains existing bold',
	)
}

async function bodyTypographyStyle(editor) {
	return editor.evaluate((element, text) => {
		const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
		let node
		while ((node = walker.nextNode())) {
			if (!node.textContent.includes(text)) continue
			const span = node.parentElement.closest('span[style]')
			if (!span) return null
			const style = getComputedStyle(span)
			return {
				fontFamily: style.fontFamily,
				fontSize: style.fontSize,
				color: style.color,
				backgroundColor: style.backgroundColor,
			}
		}
		throw new Error(`Editor text is missing: ${text}`)
	}, bodyTypographyText)
}

async function assertBodyTypographyStyle(editor) {
	const style = await bodyTypographyStyle(editor)
	assert.ok(style, 'Native editor renders the textStyle span')
	assert.match(style.fontFamily, /Noto Serif CJK SC/)
	assert.equal(style.fontSize, '24px', '18pt renders at the browser equivalent size')
	assert.equal(style.color, 'rgb(220, 38, 38)')
	assert.equal(style.backgroundColor, 'rgb(254, 240, 138)')
}

async function assertBodyTypographyPreview() {
	const fills = await page
		.locator('.typst-pages:visible svg')
		.evaluateAll((pages) =>
			pages.flatMap((svg) =>
				[...svg.querySelectorAll('*')].map((node) => getComputedStyle(node).fill),
			),
		)
	assert.ok(fills.includes('rgb(220, 38, 38)'), 'Native preview renders the selected text color')
	assert.ok(
		fills.includes('rgb(254, 240, 138)'),
		'Native preview renders the selected background color',
	)
}

async function verifyBodyEditor(entry) {
	await revealFile(entry)
	await treeItem(entry).click()
	await page
		.locator('[aria-label="报表编辑模式"]:visible')
		.getByText('正文', { exact: true })
		.click()
	const summary = page.getByRole('textbox', { name: '正文区域 summary', exact: true })
	const recommendations = page.getByRole('textbox', {
		name: '正文区域 recommendations',
		exact: true,
	})
	await summary.waitFor()
	const toolbar = page.locator('.studio-region-editor:visible').getByRole('toolbar', {
		name: '正文格式',
		exact: true,
	})
	await ready()
	assert.equal(await summary.locator('th[colspan="2"]').count(), 1)
	assert.equal(await summary.locator('td').first().locator('p').count(), 2)
	await screenshot('07-body-table')
	const region = page.getByRole('combobox', { name: '正文区域', exact: true })
	const switchRegion = async (label) => {
		await region.focus()
		await region.press('ArrowDown')
		await page.getByRole('option', { name: label, exact: true }).click()
	}
	const setCustomerName = async (name) => {
		const modes = page.locator('[aria-label="报表编辑模式"]:visible')
		await modes.getByText('表单', { exact: true }).click()
		await page.locator('input[name="customer.name"]:visible').fill(name)
		await modes.getByText('正文', { exact: true }).click()
	}
	await selectEditorText(summary, '本期服务已完成交付，详细情况如下。', true)
	await page.keyboard.press('Enter')
	// Chromium's IME path emits genuine composition events, then commits one native edit.
	const cdp = await page.context().newCDPSession(page)
	await cdp.send('Input.imeSetComposition', {
		text: '中文输入验收𠮷',
		selectionStart: 8,
		selectionEnd: 8,
	})
	await cdp.send('Input.insertText', { text: '中文输入验收𠮷' })
	await cdp.detach()
	assert.match(await summary.innerText(), /中文输入验收𠮷/)
	await setCustomerName('青山有限公司')
	await until(
		async () => (await summary.locator('[data-data-field]').first().innerText()) === '青山有限公司',
		'Data field NodeView did not receive parsed data',
	)
	await toolbar.getByRole('button', { name: '撤销', exact: true }).click()
	assert.doesNotMatch(
		await summary.innerText(),
		/中文输入验收𠮷/,
		'Data updates do not consume the native editor history',
	)
	assert.equal(await summary.locator('[data-data-field]').first().innerText(), '青山有限公司')
	await toolbar.getByRole('button', { name: '重做', exact: true }).click()
	assert.match(await summary.innerText(), /中文输入验收𠮷/)
	await selectEditorText(summary, '中文输入验收𠮷')
	await page.keyboard.press('Shift+F10')
	await page.getByRole('toolbar', { name: '选区格式', exact: true }).waitFor()
	await screenshot('07b-body-selection')
	await toolbar.getByRole('button', { name: '加粗', exact: true }).click()
	assert.match(await summary.locator('strong').last().innerText(), /中文输入验收𠮷/)
	const target = { projectId: project.id, entry }
	await until(async () => {
		const saved = await studio.getInput(target)
		return saved.data.customer?.name === '青山有限公司'
	}, 'Customer data was not saved before typography commands')
	const beforeTypography = await studio.getInput(target)
	await page.locator('.studio-region-editor:visible .typst-typography-panel > summary').click()
	const typography = page.locator('.studio-region-editor:visible').getByRole('toolbar', {
		name: '排版扩展',
		exact: true,
	})
	const applyTypography = async () => {
		await typography
			.getByRole('combobox', { name: '字体', exact: true })
			.selectOption(bodyTypography.fontFamily)
		await typography
			.getByRole('combobox', { name: '字号', exact: true })
			.selectOption(bodyTypography.fontSize)
		await typography.getByRole('button', { name: '文字颜色', exact: true }).click()
		await page
			.getByRole('dialog', { name: '文字颜色', exact: true })
			.getByRole('button', { name: '红色', exact: true })
			.click()
		await typography.getByRole('button', { name: '背景颜色', exact: true }).click()
		await page
			.getByRole('dialog', { name: '背景颜色', exact: true })
			.getByRole('button', { name: '黄色', exact: true })
			.click()
	}
	await applyTypography()
	await assertBodyTypographyStyle(summary)
	await typography.getByRole('button', { name: '清除排版', exact: true }).click()
	assert.equal(await bodyTypographyStyle(summary), null, 'Clear typography removes textStyle')
	assert.match(await summary.locator('strong').last().innerText(), /中文输入验收𠮷/)
	await applyTypography()
	await assertBodyTypographyStyle(summary)
	await until(async () => {
		const saved = await studio.getInput(target)
		const attrs = typographyTextNode(saved)?.marks?.find((mark) => mark.type === 'textStyle')?.attrs
		return Object.entries(bodyTypography).every(
			([attribute, value]) => attrs?.[attribute] === value,
		)
	}, 'Typography attributes were not persisted')
	const styledInput = await studio.getInput(target)
	assertBodyTypography(styledInput)
	assert.deepEqual(styledInput.data, beforeTypography.data, 'Typography commands preserve raw data')
	await screenshot('07c-body-typography')
	await selectEditorText(summary, bodyTypographyText)
	await page.keyboard.press('ArrowRight')
	await until(
		() =>
			summary.evaluate(
				(element) => element.editor.state.selection.empty && window.getSelection()?.isCollapsed,
			),
		'ArrowRight did not settle the native editor caret',
	)
	await page.getByRole('toolbar', { name: '选区格式', exact: true }).waitFor({ state: 'hidden' })
	await page.keyboard.press('Enter')
	assert.match(await summary.innerText(), /中文输入验收𠮷/, 'Enter retains the IME paragraph')
	await toolbar.getByRole('button', { name: '列表', exact: true }).click()
	await page.keyboard.insertText('列表项保留')
	assert.match(await summary.locator('ul').innerText(), /列表项保留/)
	assert.match(
		await summary.innerText(),
		/中文输入验收𠮷/,
		'List commands retain the IME paragraph',
	)
	await summary.locator('th').first().click()
	await toolbar.getByRole('button', { name: '表格', exact: true }).click()
	await page
		.getByRole('menu', { name: '表格操作', exact: true })
		.getByRole('menuitem', { name: '拆分单元格', exact: true })
		.click()
	assert.equal(await summary.locator('th').count(), 2)
	await toolbar.getByRole('button', { name: '撤销', exact: true }).click()
	assert.equal(await summary.locator('th[colspan="2"]').count(), 1)
	assert.match(await summary.innerText(), /中文输入验收𠮷/, 'Table undo retains the IME paragraph')
	await selectEditorText(summary, '本期服务已完成交付，详细情况如下。', true)
	await toolbar.getByRole('button', { name: '插入提示块', exact: true }).click()
	await summary.locator('aside[data-typst-notice]').waitFor()
	assert.match(
		await summary.innerText(),
		/中文输入验收𠮷/,
		'Business insertion retains nearby text',
	)
	const details = page.locator('.studio-candidate:visible')
	await details.locator('summary').click()
	await details.getByRole('button', { name: '固定候选目标', exact: true }).click()
	await details
		.getByRole('textbox', { name: 'Markdown 候选', exact: true })
		.fill('不能覆盖合并表格')
	await details.getByRole('button', { name: '查看修改预览', exact: true }).click()
	assert.equal(
		await details.getByRole('button', { name: '接纳候选', exact: true }).isDisabled(),
		true,
	)
	await details.getByRole('alert').waitFor()
	assert.match(await summary.innerText(), /交付与客户反馈/)
	await switchRegion('后续建议')
	await recommendations.click()
	await page.keyboard.press('Control+Home')
	const restrictedTable = toolbar.getByRole('button', { name: '表格', exact: true })
	assert.ok(
		(await restrictedTable.count()) === 0 || (await restrictedTable.isDisabled()),
		'Restricted regions do not offer table commands',
	)
	assert.equal(await recommendations.locator('table').count(), 0)
	await page.locator('.studio-region-editor:visible .typst-typography-panel > summary').click()
	assert.equal(await typography.count(), 1, 'Node restrictions retain allowed typography commands')
	assert.equal(
		await typography.getByRole('combobox', { name: '字号', exact: true }).isDisabled(),
		false,
	)
	await screenshot('08-body-restricted-region')
	await recommendations.click()
	await page.keyboard.press('Control+A')
	await page.keyboard.insertText('原始建议')
	await details.getByRole('button', { name: '固定候选目标', exact: true }).click()
	await details
		.getByRole('textbox', { name: 'Markdown 候选', exact: true })
		.fill('**接纳后的建议**')
	await details.getByRole('button', { name: '查看修改预览', exact: true }).click()
	await setCustomerName('海川工作室')
	await details.getByRole('button', { name: '接纳候选', exact: true }).click()
	await details.getByRole('alert').waitFor()
	assert.equal(
		await recommendations.innerText(),
		'原始建议',
		'Data changes invalidate staged candidates',
	)
	await details.getByRole('button', { name: '固定候选目标', exact: true }).click()
	await details.getByRole('button', { name: '查看修改预览', exact: true }).click()
	await details.getByRole('button', { name: '接纳候选', exact: true }).click()
	await until(
		async () => (await recommendations.innerText()) === '接纳后的建议',
		'Accepted candidate was not rendered',
	)
	assert.equal(await recommendations.innerText(), '接纳后的建议')
	await toolbar.getByRole('button', { name: '撤销', exact: true }).click()
	assert.equal(
		await recommendations.innerText(),
		'原始建议',
		'One undo restores the complete pre-candidate region',
	)
	await toolbar.getByRole('button', { name: '重做', exact: true }).click()
	await switchRegion('服务概况')
	assert.match(await summary.innerText(), /中文输入验收𠮷/)
	await until(async () => {
		const input = await studio.getInput({ projectId: project.id, entry })
		return (
			JSON.stringify(input.editor?.regions).includes('接纳后的建议') &&
			JSON.stringify(input.editor?.regions).includes('中文输入验收𠮷')
		)
	}, 'Unified body draft was not persisted')
	const input = await studio.getInput({ projectId: project.id, entry })
	assertBodyTypography(input)
	const { result, point, mapping } = await page.evaluate(
		async (request) => {
			const api = window.studioProbe.api
			const compiled = await api.compile(request)
			const preview = await api.getPreview({
				projectId: request.projectId,
				entry: request.entry,
				revision: compiled.revision,
			})
			return {
				result: compiled,
				point: preview.preview.navigation.points.find(
					(item) => item.path === '_editor/regions/summary.typ',
				),
				mapping: preview.generatedMapping,
			}
		},
		{ projectId: project.id, entry, data: input.data, editor: input.editor, clientRevision: 1000 },
	)
	assert.ok(point, 'Real native navigation includes generated region spans')
	await page.getByRole('button', { name: '刷新预览', exact: true }).click()
	await ready()
	await assertBodyTypographyPreview()
	const svg = page.locator('.typst-pages:visible .typst-page').nth(point.page - 1)
	const click = await svg.evaluate((element, hit) => {
		const position = new DOMPoint(hit.x + hit.width / 2, hit.y + hit.height / 2).matrixTransform(
			element.getScreenCTM(),
		)
		return { x: position.x, y: position.y }
	}, point)
	await page.mouse.click(click.x, click.y)
	await summary.waitFor()
	assert.equal(
		await page.locator('.flexlayout__tab_button').filter({ hasText: '_editor' }).count(),
		0,
	)
	await summary
		.locator('p')
		.first()
		.click({ position: { x: 65, y: 8 } })
	await page.locator('.preview-source-highlight:visible').waitFor()
	await screenshot('09-body-navigation')
	const pdf = join(output, 'body.pdf')
	await savePicker(pdf)
	await page.getByRole('button', { name: '导出 PDF', exact: true }).click()
	await completeFile(
		pdf,
		(bytes) =>
			bytes.subarray(0, 5).toString() === '%PDF-' &&
			bytes.subarray(-64).toString().includes('%%EOF'),
	)
	await writeFile(
		join(output, 'body-evidence.json'),
		JSON.stringify({ result, input, mapping }, null, 2),
	)
	return input
}

async function verifyDraftRecovery() {
	const directory = '报表/草稿恢复验收'
	const { entry } = await studio.createReport({ projectId: project.id, path: directory })
	const target = { projectId: project.id, entry }
	const data = { title: '已有填写数据', body: '保留这份原始输入' }
	await studio.setInput({ ...target, data, expectedVersion: null })
	const document = (text) => ({
		type: 'doc',
		content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
	})
	await studio.writeFile({
		projectId: project.id,
		path: entry.replace(/\.ts$/, '.editor.json'),
		expectedVersion: null,
		content: JSON.stringify({
			regions: [{ id: 'body', label: '正文' }],
			fields: [],
			defaults: { body: document('初始正文') },
		}),
	})
	const template = await studio.readFile({ projectId: project.id, path: `${directory}/排版.typ` })
	await studio.writeFile({
		projectId: project.id,
		path: template.path,
		expectedVersion: template.version,
		content: `${template.content}\n#include "../../_editor/regions/body.typ"\n`,
	})
	await until(
		async () => (await treeItem(directory).count()) > 0,
		'New report did not reach the tree',
	)
	await revealFile(entry)
	await treeItem(entry).click()
	await page
		.locator('[aria-label="报表编辑模式"]:visible')
		.getByText('正文', { exact: true })
		.click()
	await page.getByRole('button', { name: '初始化正文', exact: true }).click()
	const body = page.getByRole('textbox', { name: '正文区域 body', exact: true })
	await until(async () => {
		const input = await studio.getInput(target)
		return input.editor !== undefined
	}, 'Body initialization was not saved')
	const initialized = await studio.getInput(target)
	assert.deepEqual(initialized.data, data, 'Initializing regions preserves existing input')
	assert.equal(await body.innerText(), '初始正文')
	assert.equal(await page.getByRole('button', { name: '切换客户', exact: true }).count(), 0)
	await ready()
	await screenshot('10-draft-initialized')
	const details = page.locator('.studio-candidate:visible')
	await details.locator('summary').click()
	await details.getByRole('button', { name: '固定候选目标', exact: true }).click()
	await details
		.getByRole('textbox', { name: 'Markdown 候选', exact: true })
		.fill('旧草稿的未接纳候选')
	const remote = await studio.setInput({
		...target,
		data: { ...data, title: '其他写入者的标题' },
		editor: { ...initialized.editor, regions: { body: document('远端正文') } },
		expectedVersion: initialized.storageVersion,
	})
	const replaceBody = async (text) => {
		await body.click()
		await body.press('Control+A')
		await page.keyboard.insertText(text)
	}
	await replaceBody('本地冲突正文')
	await page.getByText('填写数据与正文存在保存冲突', { exact: true }).waitFor()
	assert.deepEqual(
		await studio.getInput(target),
		remote,
		'Conflicting edits cannot overwrite storage',
	)
	await screenshot('11-draft-conflict')
	await page.getByRole('button', { name: '载入已保存版本，放弃本地修改', exact: true }).click()
	await until(
		async () => (await body.innerText()) === '远端正文',
		'Loading storage did not replace the native editor',
	)
	await ready()
	await details.locator('summary').click()
	assert.equal(
		await details.getByRole('textbox', { name: 'Markdown 候选', exact: true }).inputValue(),
		'',
	)
	assert.equal(
		await details.getByRole('button', { name: '接纳候选', exact: true }).isDisabled(),
		true,
	)
	assert.equal(await page.getByRole('button', { name: '撤销', exact: true }).isDisabled(), true)
	await studio.setInput({
		...target,
		data,
		editor: remote.editor,
		expectedVersion: remote.storageVersion,
	})
	await replaceBody('明确保留本地正文')
	await page.getByRole('button', { name: '保留本地并覆盖已保存版本', exact: true }).click()
	await until(async () => {
		const input = await studio.getInput(target)
		return JSON.stringify(input.editor).includes('明确保留本地正文')
	}, 'Explicit local conflict resolution was not persisted')
	await ready()
	await screenshot('12-draft-recovered')
	await writeFile(
		join(output, 'draft-recovery.json'),
		JSON.stringify({ initialized, remote, resolved: await studio.getInput(target) }, null, 2),
	)
}

try {
	await start()
	const installedPreload = join(
		await instance.evaluate(({ app }) => app.getAppPath()),
		'dist/electron/preload.cjs',
	)
	const unknownWindow = await instance.evaluate(async ({ BrowserWindow }, preload) => {
		const other = new BrowserWindow({
			show: false,
			webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false },
		})
		try {
			await other.loadURL('data:text/html,<html>Unrelated Studio window</html>')
			return await other.webContents.executeJavaScript(
				"window.studio.saveFile({suggestedName:'denied.txt',bytes:new Uint8Array([1])}).then(()=>({accepted:true}),error=>({accepted:false,message:error.message}))",
			)
		} finally {
			other.destroy()
		}
	}, installedPreload)
	assert.equal(unknownWindow.accepted, false)
	assert.match(unknownWindow.message, /Unknown Studio sender/)
	await page.getByRole('textbox', { name: '项目名称', exact: true }).fill('桌面工作区验收')
	await page.getByRole('button', { name: '新建项目', exact: true }).click()
	await page.getByRole('button', { name: '项目', exact: true }).waitFor()
	const projects = await studio.listProjects()
	project = projects.find((item) => item.name === '桌面工作区验收')
	assert.ok(project)
	const tree = await studio.getTree({ projectId: project.id })
	documentConfig = tree.documents.find((document) => document.name === '银行询证函')
	assert.ok(documentConfig?.entry.endsWith('.ts'))
	assert.equal(tree.config.documents, undefined)
	assert.ok(!tree.entries.some((entry) => entry.path.endsWith('/data.json')))
	const foreignPath = join(output, 'foreign-file.txt')
	await writeFile(foreignPath, 'This file is outside the artifact store.')
	await savePicker(join(output, 'denied-copy.txt'))
	const foreignArtifact = await page.evaluate(async (artifactId) => {
		try {
			await window.studio.saveArtifact({ artifactId, suggestedName: 'denied-copy.txt' })
			return { accepted: true }
		} catch (error) {
			return { accepted: false, message: error.message }
		}
	}, foreignPath)
	assert.equal(foreignArtifact.accepted, false, 'A renderer path cannot be used as an artifact id')
	const workspaceArtifact = await studio.exportWorkspaceFile({ projectId: project.id })
	await instance.evaluate(({ dialog }) => {
		dialog.showSaveDialog = async () => ({ canceled: true })
	})
	assert.equal(
		await page.evaluate(
			(artifactId) => window.studio.saveArtifact({ artifactId, suggestedName: 'cancelled.zip' }),
			workspaceArtifact.id,
		),
		false,
		'Native save cancellation is an ordinary result',
	)
	const narrowCapability = await portError('resolveArtifact', { id: workspaceArtifact.id })
	assert.ok(
		!narrowCapability.unexpectedSuccess && narrowCapability.message,
		'Renderer capability cannot call the trusted main-process resolver',
	)
	await ready() // Starter opens the form and preview without a second click.
	const quarterly = tree.documents.find((document) => document.name === '季度经营分析')
	assert.ok(quarterly)
	portEvidence = await verifyPortBoundary(quarterly.entry)
	await writeFile(join(output, 'port-evidence.json'), JSON.stringify(portEvidence, null, 2))
	await verifyMultiPageUi(quarterly.entry, portEvidence.binary)
	await verifyDraftRecovery()
	const customer = tree.documents.find((document) => document.name === '客户服务报告')
	assert.ok(customer)
	const bodyInput = await verifyBodyEditor(customer.entry)
	await selectDocument()
	await openAssistant()
	const composer = page.getByRole('textbox', { name: '发送给 AI 的消息', exact: true })
	await composer.fill('@')
	const mentions = page.getByLabel('引用工作区文件', { exact: true })
	await mentions.getByText('文件夹', { exact: true }).click()
	await mentions.getByText('📁 共享/主题', { exact: true }).click()
	assert.match(
		await composer.inputValue(),
		/共享\/主题/,
		'Native assistant mention inserts workspace folder',
	)
	await screenshot('00-folder-mention')
	const retainedDraft = await composer.inputValue()
	await projectMenu('AI 助手停靠到右侧')
	await composer.waitFor()
	assert.equal(
		await composer.inputValue(),
		retainedDraft,
		'Moving the assistant retains its shared draft',
	)
	await projectMenu('关闭 AI 助手')
	await openAssistant()
	assert.equal(
		await composer.inputValue(),
		retainedDraft,
		'Reopening the assistant retains its project-owned draft',
	)
	await projectMenu('AI 助手停靠到底部')
	await composer.waitFor()
	await composer.fill('')
	const bank = () => page.getByRole('textbox', { name: '银行名称', exact: false })
	assert.equal(await bank().inputValue(), '示例银行', 'Valibot defaults populate a new form')
	await bank().fill('桌面验证银行')
	await until(async () => {
		const input = await studio.getInput({ projectId: project.id, entry: documentConfig.entry })
		return input.data.header?.bankName === '桌面验证银行'
	}, 'Form did not persist external input')
	await ready()
	await screenshot('01-form-preview')
	const pdf = join(output, 'workspace.pdf')
	await savePicker(pdf)
	await page.getByRole('button', { name: '导出 PDF', exact: true }).click()
	await completeFile(
		pdf,
		(bytes) =>
			bytes.subarray(0, 5).toString() === '%PDF-' &&
			bytes.subarray(-64).toString().includes('%%EOF'),
	)

	connection.disconnect()
	connection = undefined
	await closeInstance()
	await start()
	await page.getByRole('button', { name: '桌面工作区验收', exact: false }).first().click()
	await revealFile(customer.entry)
	await treeItem(customer.entry).click()
	await page
		.locator('[aria-label="报表编辑模式"]:visible')
		.getByText('正文', { exact: true })
		.click()
	const reopenedBody = page.getByRole('textbox', { name: '正文区域 summary', exact: true })
	assert.match(await reopenedBody.innerText(), /中文输入验收𠮷/)
	await assertBodyTypographyStyle(reopenedBody)
	const reopenedInput = await studio.getInput({ projectId: project.id, entry: customer.entry })
	assert.deepEqual(reopenedInput, bodyInput, 'Desktop reopen preserves the complete raw body draft')
	assertBodyTypography(reopenedInput)
	await ready()
	await assertBodyTypographyPreview()
	await screenshot('09b-body-typography-reopened')
	const reopenedBodyPdf = join(output, 'body-reopened.pdf')
	await savePicker(reopenedBodyPdf)
	await page.getByRole('button', { name: '导出 PDF', exact: true }).click()
	await completeFile(
		reopenedBodyPdf,
		(bytes) =>
			bytes.subarray(0, 5).toString() === '%PDF-' &&
			bytes.subarray(-64).toString().includes('%%EOF'),
	)
	await selectDocument()
	assert.equal(await bank().inputValue(), '桌面验证银行')
	const schema = await readText(documentConfig.entry)
	await openFile(documentConfig.entry)
	await replaceCode(`${schema.content}\nconst probe = v.obj`)
	await completion('object')
	await screenshot('02-completion')
	await page.keyboard.press('Escape')
	const formMetaSource = `import { formMeta } from 'valibot-form'\n${schema.content}`
	await replaceCode(`${formMetaSource}\nconst probe = formM`)
	await completion('formMeta')
	await page.keyboard.press('Escape')
	const hoverSource = `${formMetaSource}\nconst probe = formMeta`
	await replaceCode(hoverSource)
	await until(async () => {
		const saved = await readText(documentConfig.entry)
		return saved.content === hoverSource
	}, 'Hover probe did not finish autosaving')
	await ready()
	const token = page
		.locator('.monaco-editor:visible .view-line')
		.filter({ hasText: 'const probe = formMeta' })
		.getByText('formMeta', { exact: true })
	const hover = page.locator('.monaco-hover:visible').filter({ hasText: 'formMeta' })
	// Re-enter after model/diagnostic updates settle; hovering before autosave can be cancelled.
	await until(async () => {
		await page.mouse.move(10, 10)
		await token.hover()
		try {
			await hover.waitFor({ timeout: 2500 })
			return true
		} catch {
			return false
		}
	}, 'TypeScript hover did not display the real formMeta declaration')
	await screenshot('03-hover')
	await page.keyboard.press('Escape')
	await replaceCode(schema.content)
	await until(async () => {
		const file = await readText(documentConfig.entry)
		return file.content === schema.content
	}, 'Schema source not restored')
	await ready()

	const templatePath = `${documentConfig.entry.slice(0, documentConfig.entry.lastIndexOf('/'))}/排版.typ`
	const originalTyp = await readText(templatePath)
	await openFile(templatePath)
	const previousPages = await page.locator('.typst-pages:visible .typst-page').count()
	await replaceCode('#let broken = (')
	await page.locator('.monaco-editor:visible .squiggly-error').first().waitFor({ timeout: 90_000 })
	assert.equal(
		await page.locator('.typst-pages:visible .typst-page').count(),
		previousPages,
		'Typst failure keeps the last successfully rendered pages',
	)
	assert.equal(await page.getByRole('button', { name: '导出 PDF', exact: true }).isDisabled(), true)
	await screenshot('04-typst-diagnostic')
	await replaceCode(originalTyp.content)
	await ready()
	await openFile(documentConfig.entry)
	const newSchema = schema.content.replace(
		'schema: v.object({',
		"schema: v.object({\n  extra: v.pipe(v.string(), v.title('新增说明')),",
	)
	await replaceCode(newSchema)
	await selectDocument(false)
	const extra = page.getByRole('textbox', { name: '新增说明', exact: false })
	await extra.waitFor()
	assert.equal(await page.getByRole('button', { name: '导出 PDF', exact: true }).isDisabled(), true)
	await extra.fill('新增字段恢复')
	await ready()
	await screenshot('05-schema-recovery')
	await openFile(documentConfig.entry)
	await replaceCode(schema.content)
	await ready()

	// Entry code is embedded in the report tab; Typst source has its own tab beside the preview.
	await page
		.locator('[aria-label="报表编辑模式"]:visible')
		.getByText('入口代码', { exact: true })
		.waitFor()
	assert.ok(
		(await page.locator('.flexlayout__tab_button').filter({ hasText: '排版.typ' }).count()) > 0,
	)
	// External source changes still trigger HMR while input remains outside the workspace.
	const shared = await readText('共享/主题/财务函件.typ')
	await writeFile(
		join(project.root, shared.path),
		shared.content + '\n// external filesystem update\n',
	)
	await until(async () => {
		const source = await readText(shared.path)
		return source.content.includes('external filesystem update')
	}, 'External theme update did not reach workspace')
	await selectDocument(false)
	await ready()
	assert.equal(await bank().inputValue(), '桌面验证银行')

	await openAssistant()
	await page.getByRole('button', { name: '模型供应商设置', exact: true }).click()
	const settings = page.getByRole('dialog', { name: '模型供应商', exact: true })
	await settings.getByRole('textbox', { name: 'API 地址', exact: true }).waitFor()
	await until(async () => {
		const address = await settings
			.getByRole('textbox', { name: 'API 地址', exact: true })
			.inputValue()
		return address.includes('proxy-api.nas.gxyxjt.com:10001/v1')
	}, 'Company preset did not load')
	assert.equal(
		await settings.getByRole('textbox', { name: '模型 ID', exact: true }).inputValue(),
		'deepseek-flash',
	)
	await screenshot('05-provider-settings')
	await page.keyboard.press('Escape')

	await fileMenu('新建文件夹…')
	await page.getByRole('textbox', { name: '相对路径', exact: true }).fill('scratch')
	await page.getByRole('button', { name: '确定', exact: true }).click()
	await page.getByRole('dialog').waitFor({ state: 'hidden' })
	await fileMenu('新建文件…', 'scratch')
	await page.getByRole('textbox', { name: '相对路径', exact: true }).fill('scratch/note.typ')
	await page.getByRole('button', { name: '确定', exact: true }).click()
	await page.getByRole('dialog').waitFor({ state: 'hidden' })
	await replaceCode('= 新建文件\n真实文件工作区')
	await until(async () => {
		const file = await readText('scratch/note.typ')
		return file.content.includes('真实文件工作区')
	}, 'New file did not save')
	await fileMenu('重命名 / 移动…', 'scratch/note.typ')
	await page.getByRole('textbox', { name: '相对路径', exact: true }).fill('scratch/renamed.typ')
	await page.getByRole('button', { name: '确定', exact: true }).click()
	await page.getByRole('dialog').waitFor({ state: 'hidden' })
	await treeItem('scratch/renamed.typ').waitFor()
	await fileMenu('删除…', 'scratch/renamed.typ')
	await page
		.getByRole('dialog', { name: '删除文件', exact: true })
		.getByRole('button', { name: '删除', exact: true })
		.click()
	await page.getByRole('dialog', { name: '删除文件', exact: true }).waitFor({ state: 'hidden' })
	await until(async () => {
		const next = await studio.getTree({ projectId: project.id })
		return !next.entries.some((item) => item.path === 'scratch/renamed.typ')
	}, 'Delete did not remove actual file')

	const workspaceConfig = await readText('studio.json')
	await writeFile(join(project.root, 'studio.json'), '{')
	await until(async () => {
		const state = await studio.getTree({ projectId: project.id })
		return Boolean(state.configError)
	}, 'Invalid studio.json did not surface an explicit config error')
	await page
		.getByText(/Invalid studio.json:/)
		.first()
		.waitFor()
	await openFile('studio.json')
	await until(async () => {
		const content = await page.locator('.monaco-editor:visible .view-lines').innerText()
		return content.trim() === '{'
	}, 'External invalid JSON did not reach editor')
	await replaceCode(workspaceConfig.content)
	await until(async () => {
		const state = await studio.getTree({ projectId: project.id })
		return !state.configError && state.documents.length > 0
	}, 'Fixing studio.json did not recover workspace configuration')
	await selectDocument()
	await ready()

	const zip = join(output, 'workspace.zip')
	await savePicker(zip)
	await projectMenu('导出工作区 ZIP')
	await completeFile(
		zip,
		(bytes) =>
			bytes.subarray(0, 2).toString() === 'PK' &&
			bytes.subarray(-22, -18).equals(Buffer.from([0x50, 0x4b, 0x05, 0x06])),
	)
	await projectMenu('切换项目')
	await importPicker(project.root)
	await page.getByRole('button', { name: '打开本地目录…', exact: true }).click()
	await selectDocument()
	assert.equal(
		await bank().inputValue(),
		'桌面验证银行',
		'Reopening the same project retains private form input',
	)
	const reopened = await studio.listProjects()
	assert.equal(reopened.filter((item) => item.root === project.root).length, 1)
	assert.equal(reopened.find((item) => item.root === project.root).id, project.id)
	await projectMenu('切换项目')
	await importPicker(zip)
	await page.getByRole('button', { name: '导入工作区 ZIP…', exact: true }).click()
	await page.getByRole('button', { name: '项目', exact: true }).waitFor()
	await selectDocument()
	assert.equal(
		await bank().inputValue(),
		'示例银行',
		'ZIP import uses schema defaults, not private form input',
	)
	await screenshot('06-imported-workspace')
	assert.deepEqual(errors, [], 'Renderer has no uncaught errors')
	const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
	connection.disconnect()
	connection = undefined
	await closeInstance(true)
	await writeFile(
		join(output, 'result.json'),
		JSON.stringify(
			{
				executablePath,
				applicationRoot,
				clientEntry,
				passed: [
					'native sender validation, trusted artifact ids, save cancellation and narrow renderer capability',
					'real Electron MessagePort Uint8Array and cached buffer preservation',
					'structured input/schema/Typst/TypeScript/page/crop/revision errors over the real port',
					'multi-page SVG, last-page navigation, outline, and two-way source navigation',
					'explicit body initialization preserves saved data; conflict reload resets editor/candidates/history and explicit local replacement uses CAS',
					'native body composition, formatting, lists, table commands, restrictions, fields without history, staged candidates and one undo',
					'font family, 18pt, text and background colors, clear typography without clearing bold, persisted raw marks and real PDF after desktop reopen',
					'body drafts retained across region switches and desktop reopen, generated navigation and real PDF',
					'project creation and recent persistence',
					'real filesystem explorer CRUD',
					'Valibot defaults and schema recovery',
					'separate tabs and persisted external input excluded from ZIP',
					'Pi provider settings and company Responses preset',
					'native assistant folder mentions',
					'assistant draft survives native docking and close/reopen',
					'TypeScript completion and hover',
					'Typst diagnostics',
					'filesystem polling and external edits',
					'invalid workspace config editing and recovery',
					'PDF and workspace ZIP native transport',
					'native open directory reuses existing project',
					'normal and repeated quit wait for backend cleanup without shutdown errors',
				],
				portEvidence,
				viewport,
			},
			null,
			2,
		),
	)
	console.log(`Workspace desktop smoke passed: ${output}`)
} catch (error) {
	await writeFile(
		join(output, 'failure.json'),
		JSON.stringify(
			{
				error: String(error),
				stack: error?.stack,
				errors,
				exitCode: instance?.process().exitCode,
				signal: instance?.process().signalCode,
			},
			null,
			2,
		),
	)
	if (page && !page.isClosed()) await screenshot('failure').catch(() => {})
	if (page && !page.isClosed())
		await writeFile(join(output, 'failure.html'), await page.content()).catch(() => {})
	throw error
} finally {
	try {
		connection?.disconnect()
		await closeInstance(true)
	} finally {
		await writeFile(join(output, 'electron-stderr.log'), logs.join(''))
		if (process.env.STUDIO_KEEP_PROFILE !== '1') await rm(profile, { recursive: true, force: true })
	}
}
