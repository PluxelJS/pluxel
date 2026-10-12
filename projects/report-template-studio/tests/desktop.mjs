import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import electronExecutable from 'electron'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = resolve(process.env.STUDIO_SCREENSHOTS ?? join(root, 'test-results/desktop'))
const profile = await mkdtemp(join(tmpdir(), 'pluxel-workspace-desktop-'))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const errors = [],
	logs = []
let instance, page, project, documentConfig
const executablePath = process.env.STUDIO_EXECUTABLE ?? electronExecutable
const args = [
	...(process.env.STUDIO_EXECUTABLE ? [] : [root]),
	`--user-data-dir=${profile}`,
	'--disable-gpu',
	...(process.platform === 'linux' && process.env.WAYLAND_DISPLAY
		? ['--ozone-platform=wayland']
		: []),
	...(process.env.STUDIO_DISABLE_SANDBOX === '1' ? ['--no-sandbox'] : []),
]
await mkdir(output, { recursive: true })
async function start() {
	instance = await electron.launch({ executablePath, args, env, timeout: 90_000 })
	instance.process().stderr?.on('data', (bytes) => logs.push(bytes.toString()))
	page = await instance.firstWindow({ timeout: 90_000 })
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
}
async function api(path) {
	return page.evaluate(async (requestedPath) => {
		const response = await window.studio.fetch({ path: requestedPath, method: 'GET' })
		if (response.status !== 200)
			throw new Error(
				`${response.status} ${requestedPath}: ${new TextDecoder().decode(response.body)}`,
			)
		return JSON.parse(new TextDecoder().decode(response.body))
	}, path)
}
const projectPath = (suffix) => `/api/projects/${project.id}${suffix}`
const readText = (path) => api(projectPath(`/file?path=${encodeURIComponent(path)}`))
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
	await page.getByRole('menuitem', { name: action, exact: true }).click()
}
async function projectMenu(action) {
	await page.getByRole('button', { name: '项目', exact: true }).click()
	await page.getByRole('menuitem', { name: action, exact: true }).click()
}
async function openAssistant() {
	if (!(await page.getByRole('textbox', { name: '发送给 AI 的消息', exact: true }).isVisible()))
		await page.locator('.flexlayout__border_button').filter({ hasText: 'AI 助手' }).click()
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

try {
	await start()
	await page.getByRole('textbox', { name: '项目名称', exact: true }).fill('桌面工作区验收')
	await page.getByRole('button', { name: '新建项目', exact: true }).click()
	await page.getByRole('button', { name: '项目', exact: true }).waitFor()
	const projects = await api('/api/projects')
	project = projects.find((item) => item.name === '桌面工作区验收')
	assert.ok(project)
	const tree = await api(projectPath('/tree'))
	documentConfig = tree.documents.find((document) => document.name === '银行询证函')
	assert.ok(documentConfig?.entry.endsWith('.ts'))
	assert.equal(tree.config.documents, undefined)
	assert.ok(!tree.entries.some((entry) => entry.path.endsWith('/data.json')))
	await ready() // Starter opens the form and preview without a second click.
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
	await composer.fill('')
	const bank = () => page.getByRole('textbox', { name: '银行名称', exact: false })
	assert.equal(await bank().inputValue(), '示例银行', 'Valibot defaults populate a new form')
	await bank().fill('桌面验证银行')
	await until(async () => {
		const input = await api(projectPath(`/input?entry=${encodeURIComponent(documentConfig.entry)}`))
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

	await instance.close()
	instance = undefined
	await start()
	await page.getByRole('button', { name: '桌面工作区验收', exact: false }).first().click()
	await selectDocument()
	assert.equal(await bank().inputValue(), '桌面验证银行')
	const schema = await readText(documentConfig.entry)
	await openFile(documentConfig.entry)
	await replaceCode(`${schema.content}\nconst probe = v.obj`)
	await completion('object')
	await screenshot('02-completion')
	await page.keyboard.press('Escape')
	await replaceCode(`${schema.content}\nconst probe = formM`)
	await completion('formMeta')
	await page.keyboard.press('Escape')
	const hoverSource = `${schema.content}\nconst probe = formMeta`
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
	await replaceCode('#let broken = (')
	await page.locator('.monaco-editor:visible .squiggly-error').first().waitFor({ timeout: 90_000 })
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
		const next = await api(projectPath('/tree'))
		return !next.entries.some((item) => item.path === 'scratch/renamed.typ')
	}, 'Delete did not remove actual file')

	const workspaceConfig = await readText('studio.json')
	await writeFile(join(project.root, 'studio.json'), '{')
	await until(async () => {
		const state = await api(projectPath('/tree'))
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
		const state = await api(projectPath('/tree'))
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
	const reopened = await api('/api/projects')
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
	await writeFile(
		join(output, 'result.json'),
		JSON.stringify(
			{
				executablePath,
				passed: [
					'project creation and recent persistence',
					'real filesystem explorer CRUD',
					'Valibot defaults and schema recovery',
					'separate tabs and persisted external input excluded from ZIP',
					'Pi provider settings and company Responses preset',
					'native assistant folder mentions',
					'TypeScript completion and hover',
					'Typst diagnostics',
					'filesystem polling and external edits',
					'invalid workspace config editing and recovery',
					'PDF and workspace ZIP native transport',
					'native open directory reuses existing project',
				],
				viewport: await page.evaluate(() => ({ width: innerWidth, height: innerHeight })),
			},
			null,
			2,
		),
	)
	console.log(`Workspace desktop smoke passed: ${output}`)
} catch (error) {
	if (page && !page.isClosed()) await screenshot('failure').catch(() => {})
	throw error
} finally {
	await writeFile(join(output, 'electron-stderr.log'), logs.join(''))
	if (instance) {
		await instance
			.evaluate(({ BrowserWindow }) => {
				for (const window of BrowserWindow.getAllWindows()) window.destroy()
			})
			.catch(() => {})
		await instance.close().catch(() => {})
	}
	if (process.env.STUDIO_KEEP_PROFILE !== '1') await rm(profile, { recursive: true, force: true })
}
