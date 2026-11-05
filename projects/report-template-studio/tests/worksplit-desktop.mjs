import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import electronExecutable from 'electron'
import { checkWorksplitNative } from '../../../scripts/check-worksplit-native.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
checkWorksplitNative(root)
const output = resolve(process.env.STUDIO_SCREENSHOTS ?? join(root, 'test-results/worksplit'))
const profile = await mkdtemp(join(tmpdir(), 'studio-worksplit-'))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const ozonePlatform =
	process.env.STUDIO_OZONE_PLATFORM ?? (process.env.WAYLAND_DISPLAY ? 'wayland' : undefined)
const args = [
	root,
	`--user-data-dir=${profile}`,
	'--disable-gpu',
	...(process.platform === 'linux' && ozonePlatform ? [`--ozone-platform=${ozonePlatform}`] : []),
	...(process.env.STUDIO_DISABLE_SANDBOX === '1' ? ['--no-sandbox'] : []),
]
await mkdir(output, { recursive: true })
let application, page
const failures = [],
	logs = []
const checkpoints = []
try {
	application = await electron.launch({
		executablePath: electronExecutable,
		args,
		env,
		timeout: 90_000,
	})
	application.process().stderr?.on('data', (chunk) => logs.push(String(chunk)))
	const exited = once(application.process(), 'close')
	page = await application.firstWindow({ timeout: 90_000 })
	page.setDefaultTimeout(60_000)
	page.on('pageerror', (error) => failures.push(error.stack ?? String(error)))
	await application.evaluate(({ BrowserWindow }) => {
		const window = BrowserWindow.getAllWindows()[0]
		window.unmaximize()
		window.setBounds({ width: 1440, height: 900 })
	})
	await page.getByRole('button', { name: '新建项目', exact: true }).click()
	await page.locator('[aria-label="报表编辑模式"]:visible').waitFor({ timeout: 90_000 })
	await page.locator('.typst-pages:visible svg').first().waitFor({ timeout: 90_000 })
	const titles = await page.locator('.flexlayout__tab_button_content').allTextContents()
	const title = titles.find((value) => value && !value.includes('预览 ·') && value !== 'AI 助手')
	assert.ok(title, JSON.stringify(titles))
	const tabs = () => page.getByRole('tab', { name: title, exact: true })
	await tabs().first().click({ button: 'right' })
	await page.getByRole('menuitem', { name: 'Duplicate', exact: true }).click()
	await page.waitForFunction(
		(name) =>
			[...document.querySelectorAll('[role=tab]')].filter(
				(tab) => tab.getAttribute('aria-label') === name,
			).length === 2,
		title,
	)
	assert.equal(await tabs().count(), 2)
	await tabs().last().focus()
	await page.keyboard.press('Shift+F10')
	await page.getByRole('menuitem', { name: 'Split Right', exact: true }).click()
	await page.waitForFunction(() => document.querySelectorAll('.flexlayout__tabset').length === 3)
	assert.equal(await page.getByRole('menu').count(), 0)
	checkpoints.push(
		'Default context menu duplicates the real report; keyboard menu splits its independent copy.',
	)
	await page.screenshot({ path: join(output, 'desktop.png') })

	// Real native drag: move the duplicated editor back into the original editor's tab strip.
	const source = await tabs().last().boundingBox(),
		destination = await tabs().first().boundingBox()
	assert.ok(source && destination)
	await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2)
	await page.mouse.down()
	await page.mouse.move(
		destination.x + destination.width / 2,
		destination.y + destination.height / 2,
		{ steps: 12 },
	)
	await page.mouse.up()
	await page.waitForFunction(() => document.querySelectorAll('.flexlayout__tabset').length === 2)
	assert.equal(await tabs().count(), 2)
	checkpoints.push(
		'Native tab dragging merges containers without replacing either report instance.',
	)

	await application.evaluate(({ BrowserWindow }) =>
		BrowserWindow.getAllWindows()[0].setBounds({ width: 1000, height: 700 }),
	)
	await page.screenshot({ path: join(output, 'narrow.png') })
	const panes = await page.locator('[data-worksplit-content]:visible').evaluateAll((elements) =>
		elements.map((element) => {
			const rect = element.getBoundingClientRect()
			return {
				id: element.getAttribute('data-worksplit-content'),
				width: rect.width,
				height: rect.height,
			}
		}),
	)
	assert.ok(panes.length >= 2, JSON.stringify(panes))
	assert.ok(
		panes.every((pane) => pane.width > 0 && pane.height > 0),
		JSON.stringify(panes),
	)
	const formScroll = page.locator('.form-scroll:visible'),
		previewScroll = page.locator('.preview-scroll:visible')
	const formTop = await formScroll.evaluate((element) => element.scrollTop)
	await previewScroll.hover()
	await page.mouse.wheel(0, 300)
	await page.waitForFunction(() => document.querySelector('.preview-scroll')?.scrollTop > 0)
	assert.equal(await formScroll.evaluate((element) => element.scrollTop), formTop)
	assert.equal(await page.evaluate(() => document.scrollingElement.scrollTop), 0)
	checkpoints.push(
		'Narrow desktop panes retain the same tabs; scrolling the preview leaves the form and outer shell in place.',
	)

	await tabs().last().click({ button: 'right' })
	await page.getByRole('menuitem', { name: 'Close', exact: true }).click()
	await page.waitForFunction(
		(name) =>
			[...document.querySelectorAll('[role=tab]')].filter(
				(tab) => tab.getAttribute('aria-label') === name,
			).length === 1,
		title,
	)
	assert.equal(await tabs().count(), 1)

	const treeItem = (path) =>
		page.getByRole('treeitem').and(page.locator(`[data-path=${JSON.stringify(path)}]`))
	const directory = '报表/客户服务报告'
	await treeItem(`${directory}/客户服务报告.ts`).click()
	await page.locator('input[name="customer.name"]:visible').waitFor()
	await treeItem(`${directory}/data.json`).click()
	const input = page.locator('.monaco-editor:visible textarea.inputarea')
	await input.waitFor()
	await input.focus()
	await input.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
	await input.evaluate((element) => {
		const clipboardData = new DataTransfer()
		clipboardData.setData('text/plain', '{ invalid-json-draft')
		element.dispatchEvent(
			new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }),
		)
	})
	await input.press(process.platform === 'darwin' ? 'Meta+S' : 'Control+S')
	await page.getByRole('status').filter({ hasText: '保存失败' }).waitFor()
	const protectedTabs = await page.getByRole('tab').count()
	const allowed = await application.evaluate(
		({ BrowserWindow, ipcMain }) =>
			new Promise((accept) => {
				ipcMain.once('studio:close-result', (_event, result) => accept(result))
				BrowserWindow.getAllWindows()[0].close()
			}),
	)
	assert.equal(allowed, false, 'A failed shared-input save refuses the whole workspace close')
	assert.equal(page.isClosed(), false)
	assert.equal(
		await page.getByRole('tab').count(),
		protectedTabs,
		'Refused batch close preserves every tab',
	)
	const retainedDraft = await page.locator('.monaco-editor:visible .view-lines').innerText()
	assert.match(retainedDraft.replaceAll(/\s/g, ''), /invalid-json-draft/)
	await page.screenshot({ path: join(output, 'refused-close.png') })
	checkpoints.push(
		'A real shared-input save failure refuses normal window close atomically and preserves all tabs and the draft.',
	)
	await input.focus()
	await input.press(process.platform === 'darwin' ? 'Meta+Z' : 'Control+Z')
	await input.press(process.platform === 'darwin' ? 'Meta+S' : 'Control+S')
	await page.locator('.status-bar').getByText('修改自动保存在本机', { exact: true }).waitFor()
	await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
	const [code, signal] = await exited
	application = undefined
	assert.equal(code, 0)
	assert.equal(signal, null)
	assert.doesNotMatch(logs.join(''), /Studio shutdown failed/)
	checkpoints.push(
		'Normal native window close completes the protected workspace and process cleanup.',
	)
	assert.deepEqual(failures, [])
	await writeFile(
		join(output, 'results.json'),
		JSON.stringify({ checkpoints, panes, protectedTabs, code, signal, failures }, null, 2),
	)
	console.log(JSON.stringify({ ok: true, checkpoints, output }, null, 2))
} catch (error) {
	if (page && !page.isClosed()) {
		await page.screenshot({ path: join(output, 'failure.png') }).catch(() => {})
		await writeFile(join(output, 'failure.html'), await page.content()).catch(() => {})
	}
	await writeFile(
		join(output, 'failure.json'),
		JSON.stringify({ error: String(error), stack: error.stack, checkpoints, failures }, null, 2),
	)
	throw error
} finally {
	if (application) {
		await application
			.evaluate(({ BrowserWindow }) =>
				BrowserWindow.getAllWindows().forEach((window) => window.destroy()),
			)
			.catch(() => {})
		await application.close().catch(() => {})
	}
	await writeFile(join(output, 'electron-stderr.log'), logs.join(''))
	await rm(profile, { recursive: true, force: true })
}
