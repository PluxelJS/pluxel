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
import { createTypstSourceProject } from '@pluxel/plugin-typst/source'

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
const exportReceipts = []
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
	console.log(`Desktop checkpoint: ${name}`)
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
async function savedPreview(entry) {
	await ready()
	let receipt
	await until(async () => {
		const shown = page.locator('.document-preview:visible')
		const revision = await shown.getAttribute('data-preview-revision')
		if (!revision) return false
		const target = { projectId: project.id, entry }
		const [input, sourceRevision] = await Promise.all([
			studio.getInput(target),
			page.evaluate(
				async (request) => {
					try {
						const preview = await window.studioProbe.api.getPreview(request)
						return preview.sourceRevision
					} catch (cause) {
						if (cause?.code === 'REVISION_CONFLICT') return null
						throw cause
					}
				},
				{ ...target, revision },
			),
		])
		if (
			!sourceRevision ||
			sourceRevision !== input.storageVersion ||
			(await shown.getAttribute('data-preview-revision')) !== revision
		)
			return false
		receipt = { entry, revision, sourceRevision, storageVersion: input.storageVersion }
		return true
	}, 'Displayed preview did not match the saved workspace revision')
	exportReceipts.push(receipt)
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
	if (!(await navigation.isVisible()))
		await page.getByRole('button', { name: '目录与页面', exact: true }).click()
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

async function openFormat(toolbar, name = '文字格式') {
	const dialog = page.getByRole('dialog', { name, exact: true })
	if (!(await dialog.isVisible()))
		await toolbar.getByRole('button', { name: '格式', exact: true }).click()
	await dialog.waitFor()
	return dialog
}

async function insertBodyContent(toolbar, title) {
	await toolbar.getByRole('button', { name: '插入', exact: true }).click()
	const dialog = page.getByRole('dialog', { name: '插入内容', exact: true })
	await dialog.getByRole('searchbox', { name: '搜索插入内容', exact: true }).fill(title)
	await dialog.getByRole('option', { name: title, exact: true }).click()
	await dialog.waitFor({ state: 'hidden' })
}

const bodyTypographyText = '中文输入验收𠮷'
const bodyTypography = {
	fontFamily: 'Noto Serif CJK SC',
	fontSize: '18pt',
	color: 'rgba(220, 38, 38, 1)',
	backgroundColor: 'rgba(254, 240, 138, 1)',
}

function typographyTextNode(input) {
	const find = (node) => {
		if (node?.type === 'text' && node.text.includes(bodyTypographyText)) return node
		for (const child of node?.content ?? []) {
			const found = find(child)
			if (found) return found
		}
	}
	return find(
		createTypstSourceProject({ files: input.editor.files }).open('报表/客户服务报告/summary.typ')
			.document,
	)
}

function assertBodyTypography(input) {
	const node = typographyTextNode(input)
	assert.ok(node, 'Saved source retains the native composition text')
	const style = node.marks?.find((mark) => mark.type === 'textStyle')
	assert.ok(style, 'Saved source retains its textStyle mark')
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
	const imagePath = '报表/客户服务报告/pixel.png'
	const png = Buffer.from(
		'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
		'base64',
	)
	const pngFile = join(output, 'pixel.png')
	await writeFile(pngFile, png)
	await studio.importAssetFile({ projectId: project.id, path: imagePath, sourcePath: pngFile })
	const initial = await studio.getInput({ projectId: project.id, entry })
	const bodyPath = '报表/客户服务报告/summary.typ'
	await studio.setInput({
		projectId: project.id,
		entry,
		data: initial.data,
		editor: {
			files: {
				...initial.editor.files,
				[bodyPath]:
					initial.editor.files[bodyPath] +
					'\n#figure(image("pixel.png", width: 12pt), caption: [PNG image]) <fig:pixel>\n',
			},
		},
		expectedVersion: initial.storageVersion,
	})
	await revealFile(entry)
	await treeItem(entry).click()
	await page
		.locator('[aria-label="报表编辑模式"]:visible')
		.getByText('正文', { exact: true })
		.click()
	const summary = page.getByRole('textbox', {
		name: '正文源码 报表/客户服务报告/summary.typ',
		exact: true,
	})
	const recommendations = page.getByRole('textbox', {
		name: '正文源码 报表/客户服务报告/recommendations.typ',
		exact: true,
	})
	await summary.waitFor()
	await until(
		() =>
			summary
				.locator('img')
				.evaluateAll((images) =>
					images.some((image) => image.complete && image.naturalWidth === 1),
				),
		'PNG resource did not reach the source image view',
	)
	const toolbar = page.locator('.studio-region-editor:visible').getByRole('toolbar', {
		name: '正文格式',
		exact: true,
	})
	await ready()
	assert.equal(await summary.locator('th[colspan="2"]').count(), 1)
	assert.equal(await summary.locator('td').first().locator('p').count(), 2)
	const originalBlocks = await summary.evaluate((element) => element.editor.getJSON())
	await selectEditorText(summary, '本期服务已完成交付，详细情况如下。')
	await page.keyboard.press('Control+k')
	const linkDialog = page.getByRole('dialog', { name: '链接', exact: true })
	await linkDialog
		.getByRole('textbox', { name: '链接地址', exact: true })
		.fill('https://tiptap.dev')
	await linkDialog.getByRole('button', { name: '应用链接', exact: true }).click()
	assert.equal(await summary.locator('a[href="https://tiptap.dev"]').count(), 1)
	await toolbar.getByRole('button', { name: '撤销', exact: true }).click()
	assert.deepEqual(await summary.evaluate((element) => element.editor.getJSON()), originalBlocks)
	await selectEditorText(summary, '本期服务已完成交付，详细情况如下。', true)
	await page.keyboard.press('Alt+F10')
	assert.equal(
		await page.evaluate(() => document.activeElement?.getAttribute('aria-label')),
		'当前块操作',
	)
	await page.keyboard.press('Enter')
	const blockDialog = page.getByRole('dialog', { name: '块操作', exact: true })
	await blockDialog.getByRole('button', { name: '复制块', exact: true }).click()
	assert.equal(
		await summary.evaluate((element) => element.editor.state.doc.childCount),
		originalBlocks.content.length + 1,
	)
	await screenshot('07a-body-block-duplicate')
	await toolbar.getByRole('button', { name: '撤销', exact: true }).click()
	assert.deepEqual(await summary.evaluate((element) => element.editor.getJSON()), originalBlocks)
	await screenshot('07-body-table')
	const region = page.getByRole('combobox', { name: '正文文件', exact: true })
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
		async () =>
			(await summary
				.locator('.typst-source-field')
				.first()
				.locator(':scope > span')
				.first()
				.innerText()) === '青山有限公司',
		'Data field NodeView did not receive parsed data',
	)
	await toolbar.getByRole('button', { name: '撤销', exact: true }).click()
	assert.match(
		await summary.innerText(),
		/中文输入验收𠮷/,
		'Project data undo preserves previous prose',
	)
	await toolbar.getByRole('button', { name: '重做', exact: true }).click()
	assert.match(await summary.innerText(), /中文输入验收𠮷/)
	await selectEditorText(summary, '中文输入验收𠮷')
	await page.keyboard.press('Shift+F10')
	await page.getByRole('toolbar', { name: '选区格式', exact: true }).waitFor()
	await screenshot('07b-body-selection')
	const formatDialog = page.getByRole('dialog', { name: '文字格式', exact: true })
	await formatDialog.getByRole('button', { name: '加粗', exact: true }).click()
	assert.match(await summary.locator('strong').last().innerText(), /中文输入验收𠮷/)
	const explorer = page.locator('.explorer-scroll:visible')
	const explorerTop = await explorer.evaluate((element) => {
		const previous = element.scrollTop
		element.scrollTop = previous > 0 ? 0 : element.scrollHeight
		return previous
	})
	await page.evaluate(
		() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
	)
	assert.equal(
		await formatDialog.isVisible(),
		true,
		'Unrelated Explorer scrolling preserves the format context',
	)
	await explorer.evaluate((element, top) => {
		element.scrollTop = top
	}, explorerTop)
	const target = { projectId: project.id, entry }
	await until(async () => {
		const saved = await studio.getInput(target)
		return saved.data.customer?.name === '青山有限公司'
	}, 'Customer data was not saved before typography commands')
	const beforeTypography = await studio.getInput(target)
	const typography = formatDialog.getByRole('toolbar', {
		name: '排版扩展',
		exact: true,
	})
	const applyTypography = async () => {
		await openFormat(toolbar)
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
		assert.equal(await formatDialog.isVisible(), true, 'Consecutive typography keeps one context')
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
	await ready()
	await screenshot('07c-body-typography')
	// Awaiting persistence/preview can scroll the pane, which normally dismisses its anchored menu.
	if (await formatDialog.isVisible())
		await formatDialog.getByRole('button', { name: '关闭格式', exact: true }).click()
	// Cross the public RPC boundary while the native editor still owns an unsaved edit.
	const bodyAgent = await summary.evaluate(async (element, bodyTarget) => {
		const editor = element.editor
		editor.commands.insertContentAt(editor.state.doc.content.size, {
			type: 'paragraph',
			content: [{ type: 'text', text: 'Unsaved human paragraph for agent.' }],
		})
		const reading = window.studioProbe.api.readBody({
			...bodyTarget,
			path: '报表/客户服务报告/summary.typ',
		})
		const savedBefore = await window.studioProbe.api.getInput(bodyTarget)
		const snapshot = await reading
		return {
			savedBefore,
			snapshot,
			original: editor.getJSON(),
			originalSource: snapshot.files[0].source,
		}
	}, target)
	assert.doesNotMatch(
		JSON.stringify(bodyAgent.savedBefore.editor),
		/Unsaved human paragraph for agent/,
	)
	assert.match(bodyAgent.snapshot.files[0].source, /Unsaved human paragraph for agent/)
	const agentCandidate = {
		...target,
		path: '报表/客户服务报告/summary.typ',
		baseRevision: bodyAgent.snapshot.baseRevision,
		source: bodyAgent.snapshot.files[0].source.replace(
			'Unsaved human paragraph for agent.',
			'#highlight(fill: rgb("#e0f2fe"))[#text(fill: rgb("#16a34a"))[Agent revised the unsaved paragraph.]]',
		),
	}
	const agentReceipt = await studio.applyBodyCandidate(agentCandidate)
	assert.equal(agentReceipt.editorStatus, 'applied', agentReceipt.editorError)
	assert.equal(agentReceipt.previewError, undefined)
	assert.ok(agentReceipt.compile?.pageCount > 0)
	assert.match(await summary.innerText(), /Agent revised the unsaved paragraph/)
	assertBodyTypography(agentReceipt.input)
	assert.equal(await summary.locator('th[colspan="2"]').count(), 1)
	const agentPng = await studio.renderPage({
		...target,
		revision: agentReceipt.compile.revision,
		page: 1,
	})
	const agentPngBytes = await readFile(agentPng.path)
	assert.deepEqual(agentPngBytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
	await writeFile(join(output, 'agent-body.png'), agentPngBytes)
	await assert.rejects(async () => await studio.applyBodyCandidate(agentCandidate), {
		code: 'STALE_CANDIDATE',
	})
	await ready()
	await screenshot('07d-agent-body-preview')
	await toolbar.getByRole('button', { name: '撤销', exact: true }).click()
	assert.deepEqual(
		await summary.evaluate((element) => element.editor.getJSON()),
		bodyAgent.original,
		'One undo restores the unsaved human body, including merged table and typography',
	)
	await until(async () => {
		const savedUndo = await studio.getInput(target)
		return savedUndo.editor?.files['报表/客户服务报告/summary.typ'] === bodyAgent.originalSource
	}, 'Undo did not persist through the shared input boundary')
	await writeFile(
		join(output, 'agent-body-evidence.json'),
		JSON.stringify(
			{
				snapshot: bodyAgent.snapshot,
				receipt: agentReceipt,
				png: agentPng,
				undo: bodyAgent.original,
			},
			null,
			2,
		),
	)
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
	await openFormat(toolbar)
	await formatDialog.getByRole('button', { name: '列表', exact: true }).click()
	const listScroll = await page.locator('.body-editor-scroll:visible').evaluate((element) => {
		const before = element.scrollTop
		element.scrollTop = before > 0 ? before - 1 : 6
		return { before, after: element.scrollTop }
	})
	assert.notEqual(
		listScroll.after,
		listScroll.before,
		'The editor scrolls while the list menu closes',
	)
	await summary.evaluate(
		() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
	)
	await page.keyboard.press('Escape')
	await formatDialog.waitFor({ state: 'hidden' })
	assert.equal(
		await summary.evaluate((element) => {
			const selection = element.ownerDocument.getSelection()
			return (
				element.ownerDocument.activeElement === element &&
				selection?.isCollapsed &&
				selection.anchorNode &&
				element.contains(selection.anchorNode) &&
				element.editor.view.posAtDOM(selection.anchorNode, selection.anchorOffset) ===
					element.editor.state.selection.from &&
				element.editor.state.selection.$from.parent.type.name === 'paragraph' &&
				element.editor.state.selection.$from.node(-1).type.name === 'listItem'
			)
		}),
		true,
		'Scrolling closes the format menu and restores its current list caret before typing',
	)
	await page.keyboard.insertText('列表项保留')
	assert.match(await summary.locator('ul').innerText(), /列表项保留/)
	await toolbar.getByRole('button', { name: '撤销', exact: true }).click()
	assert.doesNotMatch(await summary.locator('ul').innerText(), /列表项保留/)
	await toolbar.getByRole('button', { name: '重做', exact: true }).click()
	assert.match(await summary.locator('ul').innerText(), /列表项保留/)
	assert.match(
		await summary.innerText(),
		/中文输入验收𠮷/,
		'List commands retain the IME paragraph',
	)
	await summary.locator('th').first().scrollIntoViewIfNeeded()
	await summary.evaluate(
		() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
	)
	await summary.locator('th').first().click()
	await page
		.locator('.studio-region-editor:visible')
		.getByRole('toolbar', { name: '表格快捷操作', exact: true })
		.getByRole('button', { name: '拆分单元格', exact: true })
		.click()
	assert.equal(await summary.locator('th').count(), 2)
	await toolbar.getByRole('button', { name: '撤销', exact: true }).click()
	assert.equal(await summary.locator('th[colspan="2"]').count(), 1)
	assert.match(await summary.innerText(), /中文输入验收𠮷/, 'Table undo retains the IME paragraph')
	await selectEditorText(summary, '本期服务已完成交付，详细情况如下。', true)
	await insertBodyContent(toolbar, '提示块')
	await summary.locator('.typst-source-card').last().waitFor()
	assert.match(
		await summary.innerText(),
		/中文输入验收𠮷/,
		'Business insertion retains nearby text',
	)
	const details = page.locator('.studio-candidate:visible')
	await details.locator('summary').click()
	await details.getByRole('button', { name: '固定候选目标', exact: true }).click()
	await details.getByRole('textbox', { name: 'Typst 候选', exact: true }).fill('#let broken = (')
	await details.getByRole('button', { name: '查看修改预览', exact: true }).click()
	assert.equal(
		await details.getByRole('button', { name: '接纳候选', exact: true }).isDisabled(),
		false,
		'Raw source can be reviewed even before syntax repair',
	)
	assert.match(await summary.innerText(), /交付与客户反馈/)
	await switchRegion('后续建议')
	assert.equal(
		await recommendations.locator('.typst-component').count(),
		1,
		'Service notice remains an ordinary source component',
	)
	await screenshot('08-body-component')
	const originalImports = await recommendations.evaluate((element) =>
		element.editor.getJSON().content.filter((node) => node.type === 'typstSource'),
	)
	await selectEditorText(recommendations, '安排下期服务计划。')
	await page.keyboard.insertText('原始建议')
	assert.match(await recommendations.innerText(), /原始建议/)
	assert.equal(await recommendations.locator('.typst-component').count(), 1)
	assert.deepEqual(
		await recommendations.evaluate((element) =>
			element.editor.getJSON().content.filter((node) => node.type === 'typstSource'),
		),
		originalImports,
		'Editing prose retains the exact import environment nodes',
	)
	const originalRecommendations = await recommendations.evaluate((element) =>
		element.editor.getJSON(),
	)
	await details.getByRole('button', { name: '固定候选目标', exact: true }).click()
	await details.getByRole('textbox', { name: 'Typst 候选', exact: true }).fill('*接纳后的建议*')
	await details.getByRole('button', { name: '查看修改预览', exact: true }).click()
	await setCustomerName('海川工作室')
	await details.getByRole('button', { name: '接纳候选', exact: true }).click()
	await page
		.locator('.body-editor-scroll:visible')
		.getByRole('alert')
		.filter({ hasText: '候选目标已过期' })
		.waitFor()
	assert.deepEqual(
		await recommendations.evaluate((element) => element.editor.getJSON()),
		originalRecommendations,
		'Data changes invalidate staged candidates and preserve source content',
	)
	await details.getByRole('button', { name: '固定候选目标', exact: true }).click()
	assert.equal(
		await details.getByRole('textbox', { name: 'Typst 候选', exact: true }).inputValue(),
		'*接纳后的建议*',
		'Recapturing preserves the edited candidate until explicitly replaced',
	)
	const capturedOriginal = await details
		.locator('.studio-candidate-comparison section')
		.first()
		.locator('pre')
		.innerText()
	await details.getByRole('button', { name: '用原文替换候选', exact: true }).click()
	assert.equal(
		await details.getByRole('textbox', { name: 'Typst 候选', exact: true }).inputValue(),
		capturedOriginal,
	)
	await details.getByRole('textbox', { name: 'Typst 候选', exact: true }).fill('*接纳后的建议*')
	await details.getByRole('button', { name: '查看修改预览', exact: true }).click()
	await details.getByRole('button', { name: '接纳候选', exact: true }).click()
	await until(
		async () => (await recommendations.innerText()) === '接纳后的建议',
		'Accepted candidate was not rendered',
	)
	assert.equal(await recommendations.innerText(), '接纳后的建议')
	await toolbar.getByRole('button', { name: '撤销', exact: true }).click()
	assert.deepEqual(
		await recommendations.evaluate((element) => element.editor.getJSON()),
		originalRecommendations,
		'One undo restores the complete source, including imports and component',
	)
	await toolbar.getByRole('button', { name: '重做', exact: true }).click()
	await switchRegion('服务概况')
	assert.match(await summary.innerText(), /中文输入验收𠮷/)
	await until(async () => {
		const input = await studio.getInput({ projectId: project.id, entry })
		return (
			JSON.stringify(input.editor?.files).includes('接纳后的建议') &&
			JSON.stringify(input.editor?.files).includes('中文输入验收𠮷')
		)
	}, 'Unified body draft was not persisted')
	const input = await studio.getInput({ projectId: project.id, entry })
	assertBodyTypography(input)
	await ready()
	const displayedPreview = page.locator('.document-preview[data-preview-current="true"]:visible')
	let navigation
	await until(async () => {
		const revision = await displayedPreview.getAttribute('data-preview-revision')
		if (!revision) return false
		navigation = await page.evaluate(
			async (request) => {
				try {
					const preview = await window.studioProbe.api.getPreview(request)
					return {
						result: {
							revision: preview.revision,
							clientRevision: preview.clientRevision,
							sourceRevision: preview.sourceRevision,
							pageCount: preview.preview.navigation.pages.length,
						},
						point: preview.preview.navigation.points.find(
							(item) => item.path === '报表/客户服务报告/summary.typ',
						),
						mapping: preview.preview.navigation.points,
					}
				} catch (error) {
					if (error.code === 'REVISION_CONFLICT') return null
					throw error
				}
			},
			{ projectId: project.id, entry, revision },
		)
		return Boolean(
			navigation && (await displayedPreview.getAttribute('data-preview-revision')) === revision,
		)
	}, 'The current displayed revision did not expose its native source mapping')
	const { result, point, mapping } = navigation
	assert.ok(point, 'Real native navigation includes ordinary source spans')
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
	await until(
		() =>
			summary.evaluate(
				(element) =>
					element.editor.state.selection.toJSON().type === 'node' &&
					element.editor.state.selection.node?.type.name === 'typstField',
			),
		'Preview navigation did not select the source field before the authored-text click',
	)
	const authoredParagraph = summary.locator('p').filter({ hasText: '本期服务已完成交付' }).first()
	await authoredParagraph.scrollIntoViewIfNeeded()
	const authoredGlyph = await authoredParagraph.evaluate((element) => {
		const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
		while (walker.nextNode()) {
			const text = walker.currentNode
			const offset = text.textContent.indexOf('本期服务已完成交付')
			if (offset < 0) continue
			const range = document.createRange()
			range.setStart(text, offset + 5)
			range.setEnd(text, offset + 6)
			const rect = range.getBoundingClientRect()
			return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
		}
		throw new Error('Authored source text has no rendered glyph')
	})
	await page.mouse.click(authoredGlyph.x, authoredGlyph.y)
	await until(
		() => summary.evaluate((element) => element.editor.state.selection.toJSON().type === 'text'),
		'Clicking authored text settles the selection after preview selected the field',
	)
	await page.locator('.preview-source-highlight:visible').waitFor()
	await screenshot('09-body-navigation')
	const pdf = join(output, 'body.pdf')
	await savedPreview(entry)
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
	const initial = await studio.getInput(target)
	await studio.setInput({ ...target, data, expectedVersion: initial.storageVersion })
	const bodyPath = `${directory}/workspace.typ`
	await studio.writeFile({
		projectId: project.id,
		path: bodyPath,
		expectedVersion: null,
		content: '初始正文',
	})
	await studio.writeFile({
		projectId: project.id,
		path: entry.replace(/\.ts$/, '.editor.json'),
		expectedVersion: null,
		content: JSON.stringify({ sources: [{ path: 'workspace.typ', label: '正文' }] }),
	})
	const template = await studio.readFile({ projectId: project.id, path: `${directory}/排版.typ` })
	await studio.writeFile({
		projectId: project.id,
		path: template.path,
		expectedVersion: template.version,
		content: template.content + '\n#include "workspace.typ"\n',
	})

	await until(
		async () => (await treeItem(directory).count()) > 0,
		'New report did not reach the tree',
	)
	const saveSource = () =>
		page
			.locator('.monaco-editor:visible textarea.inputarea')
			.press(process.platform === 'darwin' ? 'Meta+S' : 'Control+S')
	// Open the ordinary file before its report owner exists, without relying on
	// whether autosave or the explicit shortcut reaches the backend first.
	const fileFirstBody = '先在源码文件页保存的正文'
	await openFile(bodyPath)
	await replaceCode(fileFirstBody)
	await saveSource()
	await until(async () => {
		const source = await readText(bodyPath)
		return source.content === fileFirstBody
	}, 'File-first Monaco source did not save before opening its report')
	assert.equal(await readFile(join(project.root, bodyPath), 'utf8'), fileFirstBody)
	await revealFile(entry)
	await treeItem(entry).click()
	await page
		.locator('[aria-label="报表编辑模式"]:visible')
		.getByText('正文', { exact: true })
		.click()
	const body = page.getByRole('textbox', { name: `正文源码 ${bodyPath}`, exact: true })
	await until(async () => {
		const input = await studio.getInput(target)
		return input.editor !== undefined
	}, 'Existing source snapshot was not loaded')
	const initialized = await studio.getInput(target)
	assert.deepEqual(initialized.data, data, 'Opening source preserves existing input')
	assert.equal(await body.innerText(), fileFirstBody, 'Opening the report adopts the saved file')
	assert.equal(await page.getByRole('button', { name: '切换客户', exact: true }).count(), 0)
	await ready()
	await screenshot('10-draft-initialized')
	const details = page.locator('.studio-candidate:visible')
	await details.locator('summary').click()
	await details.getByRole('button', { name: '固定候选目标', exact: true }).click()
	await details.getByRole('textbox', { name: 'Typst 候选', exact: true }).fill('旧草稿的未接纳候选')
	const remote = await studio.setInput({
		...target,
		data: { ...data, title: '其他写入者的标题' },
		editor: { files: { ...initialized.editor.files, [bodyPath]: '远端正文' } },
		expectedVersion: initialized.storageVersion,
	})
	const replaceBody = async (text) => {
		await body.click()
		await body.press('Control+A')
		await page.keyboard.insertText(text)
	}
	await replaceBody('本地冲突正文')
	await page
		.locator('.workspace-pane:visible')
		.getByText('填写数据与正文存在保存冲突', { exact: true })
		.waitFor()
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
		await details.getByRole('textbox', { name: 'Typst 候选', exact: true }).inputValue(),
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

	const dataPath = `${directory}/data.json`
	const sharedBody = '从已加载报表的源码页保存的正文'
	const sharedData = { title: '源码页保存的标题', body: '源码页保存的数据正文' }
	const sharedDataSource = JSON.stringify(sharedData, null, 2) + '\n'
	await openFile(bodyPath)
	await replaceCode(sharedBody)
	await saveSource()
	await until(async () => {
		const input = await studio.getInput(target)
		return input.editor?.files[bodyPath] === sharedBody
	}, 'Body file shortcut did not save through the loaded report input')
	await openFile(dataPath)
	await replaceCode(sharedDataSource)
	await saveSource()
	await until(async () => {
		const input = await studio.getInput(target)
		return (
			input.data.title === sharedData.title && input.editor?.files[dataPath] === sharedDataSource
		)
	}, 'JSON file shortcut did not save through the loaded report input')
	const saved = await studio.getInput(target)
	assert.deepEqual(saved.data, sharedData)
	assert.equal(saved.editor.files[bodyPath], sharedBody)
	assert.equal(await readFile(join(project.root, bodyPath), 'utf8'), sharedBody)
	assert.equal(await readFile(join(project.root, dataPath), 'utf8'), sharedDataSource)
	const showSharedReport = async () => {
		await treeItem(entry).click()
		const modes = page.locator('[aria-label="报表编辑模式"]:visible')
		await modes.getByText('表单', { exact: true }).click()
		await until(
			async () =>
				(await page.getByRole('textbox', { name: '标题', exact: true }).inputValue()) ===
				sharedData.title,
			'The loaded form did not receive the JSON file title',
		)
		assert.equal(
			await page.getByRole('textbox', { name: '正文', exact: true }).inputValue(),
			sharedData.body,
		)
		await modes.getByText('正文', { exact: true }).click()
		await until(
			async () => (await body.innerText()) === sharedBody,
			'The loaded body editor did not receive its source file content',
		)
		await ready()
	}
	await showSharedReport()
	await screenshot('13-source-file-shared-save')

	// Invalid JSON keeps the complete input draft unsaved. A subsequent body edit
	// can therefore exercise the real whole-report reload without a timer race.
	const sourcePane = () =>
		page.locator('.workspace-pane:visible').filter({ has: page.locator('.monaco-editor:visible') })
	await openFile(dataPath)
	await replaceCode('{ invalid-json-draft')
	await saveSource()
	await sourcePane().getByRole('status').filter({ hasText: '保存失败' }).waitFor()
	await openFile(bodyPath)
	await replaceCode('等待整份报表重载放弃的正文草稿')
	await saveSource()
	await sourcePane().getByRole('status').filter({ hasText: '保存失败' }).waitFor()
	assert.deepEqual(await studio.getInput(target), saved, 'Failed input save preserves storage')
	await sourcePane().getByRole('button', { name: '文件操作', exact: true }).click()
	const reload = page.getByRole('menuitem', { name: '从磁盘重新载入整份报表', exact: true })
	assert.equal(await reload.isEnabled(), true)
	const confirmation = page.waitForEvent('dialog')
	await reload.click()
	const dialog = await confirmation
	assert.match(dialog.message(), /全部数据与正文草稿/)
	await until(async () => {
		const source = await page.locator('.monaco-editor:visible .view-lines').innerText()
		return source.includes(sharedBody)
	}, 'Whole-report reload did not restore the body file view')
	await openFile(dataPath)
	await until(async () => {
		const source = await page.locator('.monaco-editor:visible .view-lines').innerText()
		return source.includes(sharedData.title)
	}, 'Whole-report reload did not restore the JSON file view')
	assert.doesNotMatch(
		await page.locator('.monaco-editor:visible .view-lines').innerText(),
		/invalid-json-draft/,
	)
	await showSharedReport()
	const reloaded = await studio.getInput(target)
	assert.deepEqual(reloaded, saved, 'Reload reads the saved input without a replacement write')
	assert.equal(await readFile(join(project.root, bodyPath), 'utf8'), sharedBody)
	assert.equal(await readFile(join(project.root, dataPath), 'utf8'), sharedDataSource)
	await screenshot('14-source-file-report-reloaded')
	await writeFile(
		join(output, 'source-file-views.json'),
		JSON.stringify({ entry, bodyPath, dataPath, fileFirstBody, saved, reloaded }, null, 2),
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
	assert.ok(tree.entries.some((entry) => entry.path.endsWith('/data.json')))
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
	assert.ok(
		(await page.locator('.document-preview').count()) >= 5,
		'Bank input refresh and PDF export exercise more reports than the four native session slots',
	)
	await bank().fill('桌面验证银行')
	await until(async () => {
		const input = await studio.getInput({ projectId: project.id, entry: documentConfig.entry })
		return input.data.header?.bankName === '桌面验证银行'
	}, 'Form did not persist external input')
	await ready()
	await screenshot('01-form-preview')
	const pdf = join(output, 'workspace.pdf')
	await savedPreview(documentConfig.entry)
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
	const reopenedBody = page.getByRole('textbox', {
		name: '正文源码 报表/客户服务报告/summary.typ',
		exact: true,
	})
	assert.match(await reopenedBody.innerText(), /中文输入验收𠮷/)
	await assertBodyTypographyStyle(reopenedBody)
	const reopenedInput = await studio.getInput({ projectId: project.id, entry: customer.entry })
	assert.equal(
		reopenedInput.editor.files['报表/客户服务报告/summary.typ'],
		bodyInput.editor.files['报表/客户服务报告/summary.typ'],
		'Desktop reopen preserves the authored source',
	)
	assert.deepEqual(reopenedInput.data, bodyInput.data)
	assertBodyTypography(reopenedInput)
	await ready()
	await assertBodyTypographyPreview()
	await screenshot('09b-body-typography-reopened')
	const reopenedBodyPdf = join(output, 'body-reopened.pdf')
	await savedPreview(customer.entry)
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
	await until(async () => {
		const input = await studio.getInput({ projectId: project.id, entry: documentConfig.entry })
		return input.data.extra === '新增字段恢复'
	}, 'New schema field did not persist against its current source snapshot')
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
	// External source changes still trigger HMR with data stored in the same workspace.
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
		'Reopening the same project reads the saved data.json',
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
		'桌面验证银行',
		'ZIP import preserves the ordinary data.json input',
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
					'opening ordinary body sources preserves saved data; conflict reload resets editor/candidates/history and explicit local replacement uses CAS',
					'Monaco body/data shortcuts share report input and disk state; file-first saved content reaches the form, and the file menu reloads all failed report drafts',
					'native body composition, formatting, lists, tables, source environment protection, shared data history, staged candidates and one undo',
					'shared link editing and current-block duplication in the real desktop renderer, each reverted by one native undo',
					'font family, 18pt, text and background colors, clear typography without clearing bold, persisted source marks and real PDF after desktop reopen',
					'source drafts retained across file switches and desktop reopen, ordinary source navigation and real PDF',
					'project creation and recent persistence',
					'real filesystem explorer CRUD',
					'Valibot defaults and schema recovery',
					'separate tabs and ordinary data.json input preserved through ZIP export/import',
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
				exportReceipts,
				viewport,
			},
			null,
			2,
		),
	)
	console.log(`Workspace desktop smoke passed: ${output}`)
} catch (error) {
	if (studio && project) {
		try {
			const saved = await studio.getInput({
				projectId: project.id,
				entry: '报表/客户服务报告/客户服务报告.ts',
			})
			await writeFile(
				join(output, 'failure-source.json'),
				JSON.stringify(
					{
						storageVersion: saved.storageVersion,
						data: saved.data,
						summary: saved.editor?.files['报表/客户服务报告/summary.typ'],
						recommendations: saved.editor?.files['报表/客户服务报告/recommendations.typ'],
					},
					null,
					2,
				),
			)
		} catch {}
	}
	if (page && !page.isClosed()) {
		try {
			const editors = await page.locator('.tiptap').evaluateAll((elements) =>
				elements.flatMap((element) => {
					if (!element.editor) return []
					return [
						{
							path: element.getAttribute('aria-label'),
							document: element.editor.getJSON(),
							selection: element.editor.state.selection.toJSON(),
						},
					]
				}),
			)
			await writeFile(join(output, 'failure-editor.json'), JSON.stringify(editors, null, 2))
		} catch {}
	}
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
