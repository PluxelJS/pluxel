import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, promisify } from 'node:util'
import { chromium, expect } from 'playwright/test'

// This intentionally targets an existing Host. Backend operations use its dev console.
const { values } = parseArgs({
	options: {
		origin: { type: 'string' },
		root: { type: 'string' },
		instance: { type: 'string' },
		'ws-endpoint': { type: 'string' },
		artifacts: { type: 'string', default: '/tmp/pluxel-workbench-browser' },
		lifecycle: { type: 'boolean', default: false },
	},
})
if (!values.origin || !values.root || !values.instance)
	throw new Error(
		'Required: --origin URL --root ABSOLUTE_PROJECT_ROOT --instance DISCOVERED_INSTANCE_ID',
	)
const project = fileURLToPath(new URL('../', import.meta.url))
const repository = fileURLToPath(new URL('../../../', import.meta.url))
assert.equal(
	resolve(values.root),
	resolve(project),
	'Select this script’s discovered plugin-host instance',
)
const origin = new URL(values.origin).origin
const basepath = '/__pluxel/workbench'
let storageKey
const artifacts = resolve(values.artifacts)
await mkdir(artifacts, { recursive: true })
const receipt = {
	origin,
	root: values.root,
	instance: values.instance,
	lifecycle: values.lifecycle,
	checks: [],
	errors: [],
	resourceFailures: [],
	websocketPaths: [],
	documentNavigations: [],
	runtimeSessionDocuments: [],
	boundaries: [
		'Browser checks use the existing published View/Content and business dirty guards; they do not inject production cleanup failures.',
		'Cleanup-error receipts and late-resource reporting are covered by the Shell real-SDK integration tests, not this browser run.',
	],
}
const command = promisify(execFile)
async function consoleRun(exportName, file = 'workbench.ts', input) {
	const args = [
		resolve(repository, 'packages/cli/bin/pluxel.mjs'),
		'dev',
		'run',
		resolve(project, 'dev', file),
		'--export',
		exportName,
		'--root',
		values.root,
		'--instance',
		values.instance,
	]
	if (input) args.push('--input', JSON.stringify(input))
	const { stdout, stderr } = await command(process.execPath, args, {
		cwd: repository,
		maxBuffer: 2 ** 22,
	})
	const result = JSON.parse(stdout)
	const accepted = stderr
		.trim()
		.split('\n')
		.map((line) => JSON.parse(line))
		.find((event) => event.event === 'accepted')
	assert.ok(accepted?.receipt, 'The dev console preserves the original accepted receipt')
	assert.equal(result.ok, true, JSON.stringify(result))
	assert.equal(result.value.state, 'succeeded', JSON.stringify(result.value))
	receipt.console ??= []
	receipt.console.push({
		exportName,
		receipt: accepted.receipt,
		runId: result.value.runId,
		hostEpoch: result.value.hostEpoch,
		revisions: result.value.revisions,
		value: result.value.value,
	})
	return result.value.value
}
async function check(name, run) {
	await run()
	receipt.checks.push(name)
	console.log(`PASS ${name}`)
}
const flatten = (node) => [node, ...(node.children ?? []).flatMap(flatten)]
const nodes = (snapshot) =>
	snapshot ? [snapshot.layout.layout, ...(snapshot.layout.borders ?? [])].flatMap(flatten) : []
const browser = await chromium.connect(
	values['ws-endpoint'] ?? process.env.PLAYWRIGHT_WS_ENDPOINT ?? 'ws://127.0.0.1:3000',
	{ exposeNetwork: '<loopback>' },
)
const context = await browser.newContext({
	viewport: { width: 1440, height: 900 },
	colorScheme: 'light',
})
const page = await context.newPage()
let holdReplies = false
let runtimeReleases = 0
const delayedReplies = []
await page.routeWebSocket('**/__pluxel/runtime/session', (socket) => {
	const server = socket.connectToServer()
	socket.onMessage((message) => {
		const frame = JSON.parse(String(message))
		if (Array.isArray(frame) && frame[0] === 'release') runtimeReleases++
		server.send(message)
	})
	server.onMessage((message) => {
		if (holdReplies) delayedReplies.push(() => socket.send(message))
		else socket.send(message)
	})
})
function releaseReplies() {
	holdReplies = false
	for (const send of delayedReplies.splice(0)) send()
}
const runtimeSockets = new Set()
let runtimeDocument
page.setDefaultTimeout(20000)
page.on('pageerror', (error) => receipt.errors.push(error.message))
page.on('websocket', (socket) => {
	const path = new URL(socket.url()).pathname
	receipt.websocketPaths.push(path)
	if (path === '/__pluxel/runtime/session') {
		assert.ok(runtimeDocument, 'A runtime socket belongs to a real main-frame document request')
		const document = runtimeDocument
		document.opened++
		runtimeSockets.add(socket)
		socket.on('close', () => {
			document.closed++
			runtimeSockets.delete(socket)
		})
	}
})
page.on('request', (request) => {
	if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
		const path = new URL(request.url()).pathname
		receipt.documentNavigations.push(path)
		// Playwright clears old document socket records on navigation without emitting close.
		// Count within each real document; native Router navigation does not create this request.
		runtimeSockets.clear()
		runtimeDocument = { path, opened: 0, closed: 0 }
		receipt.runtimeSessionDocuments.push(runtimeDocument)
	}
})
page.on('console', (message) => {
	if (message.type() === 'error') receipt.errors.push(message.text())
})
page.on('response', (response) => {
	if (response.status() >= 400)
		receipt.resourceFailures.push({ url: response.url(), status: response.status() })
})
const tabs = page.locator('.flexlayout__tab_button')
const navigation = page.locator('.plx-workspace-navigation:visible')
const entry = (label) =>
	navigation.locator('.plx-workspace-navigation__link').filter({ hasText: label })
const tab = (name) =>
	page.getByRole('tab', {
		name: new RegExp(`^${name.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?: \\(已固定\\))?$`),
	})
const reportInput = (name) =>
	page
		.getByRole('tabpanel', { name, exact: true })
		.getByRole('textbox', { name: 'Report title', exact: true })
const menu = () => page.getByRole('menu')
const snapshot = () => {
	assert.ok(storageKey, 'Discover the isolated workspace snapshot before reading it')
	return page.evaluate((key) => {
		const raw = localStorage.getItem(key)
		if (raw === null) throw new Error(`Workspace snapshot is missing: ${key}`)
		return JSON.parse(raw)
	}, storageKey)
}
async function discoverSnapshotKey() {
	const keys = () =>
		page.evaluate(
			(workspaceBasepath) =>
				Object.keys(localStorage).filter(
					(key) => key.startsWith('pluxel:worksplit:') && key.endsWith(`:${workspaceBasepath}`),
				),
			basepath,
		)
	await expect
		.poll(keys, { message: 'One snapshot written by this isolated browser context' })
		.toHaveLength(1)
	const discovered = await keys()
	storageKey = discovered[0]
	receipt.storageKey = storageKey
}
async function findWorkspaceEntry(name) {
	await page.getByRole('button', { name: '查找所有工作区入口', exact: true }).click()
	const dialog = page.getByRole('dialog', { name: '查找工作区入口', exact: true })
	await expect(dialog).toBeVisible()
	await dialog.getByRole('button', { name, exact: true }).click()
	await expect(dialog).toHaveCount(0)
}
async function notificationHistory() {
	await page.getByRole('button', { name: /^通知历史，/ }).click()
	await expect(page.getByRole('button', { name: '清空历史', exact: true })).toBeVisible()
	return page.locator('.plx-workspace__notification')
}
async function showApps() {
	if (await tab('应用').count()) await tab('应用').click()
	else await duplicateDocument(tab('首页').first())
	await page.locator('.plx-activity [aria-label="应用"]').click()
	await expect(page).toHaveURL(origin + basepath + '/apps')
	await expect(navigation).toHaveCount(1)
	await expect(navigation).toBeVisible()
}
async function nativeTabOf(content) {
	const panelId = await content.evaluate((element) => element.closest('[role="tabpanel"]')?.id)
	assert.ok(panelId, 'Native content must belong to a tabpanel')
	return page.locator(`[role="tab"][aria-controls=${JSON.stringify(panelId)}]`)
}
async function duplicateDocument(target, placement) {
	const documentIds = () =>
		tabs.evaluateAll((elements) => elements.map((element) => element.getAttribute('aria-controls')))
	const before = new Set(await documentIds())
	await target.click()
	if (placement) {
		await openMenu(target)
		await menu().getByRole('menuitem', { name: placement, exact: true }).click()
	} else {
		await target.getByRole('button', { name: '复制当前标签页', exact: true }).click()
	}
	const added = async () => {
		const current = await documentIds()
		return current.filter((id) => !before.has(id))
	}
	await expect.poll(added).toHaveLength(1)
	const [id] = await added()
	const copy = tabs.and(page.locator(`[aria-controls=${JSON.stringify(id)}]`))
	return copy
}
async function openMenu(target) {
	await target.click({ button: 'right' })
	await expect(menu()).toBeVisible()
	return menu()
}
async function rename(target, name) {
	await target.focus()
	await page.keyboard.press('F2')
	const input = page.getByRole('textbox', { name: '重命名标签', exact: true })
	await input.fill(name)
	await input.press('Enter')
	await expect(tab(name)).toBeVisible()
}
async function mouseDrop(source, target, side) {
	const from = await source.boundingBox(),
		to = await target.boundingBox()
	assert.ok(from && to)
	const x = from.x + from.width / 2,
		y = from.y + from.height / 2
	const destination = side === 'right' ? to.x + to.width - 8 : to.x + to.width / 2
	await page.mouse.move(x, y)
	await page.mouse.down()
	await page.mouse.move(x + 15, y, { steps: 5 })
	await page.mouse.move(destination, to.y + to.height / 2, { steps: 15 })
	await page.waitForTimeout(150)
	await page.mouse.up()
}
let stopped = false
try {
	const online = await consoleRun('default')
	assert.equal(online.studio.lifecycleState, 'running')
	assert.equal(online.opened.kind, 'view')
	await check(
		'explicit native copies retain built-ins; same URL reuse and browser history',
		async () => {
			await page.goto(origin + basepath)
			await expect(tab('首页')).toBeVisible()
			await duplicateDocument(tab('首页'))
			await page.locator('.plx-activity [aria-label="日志"]').click()
			await expect(tab('日志')).toBeVisible()
			await expect(page).toHaveURL(origin + basepath + '/logs')
			await page.locator('.plx-activity [aria-label="日志"]').click()
			await expect(tabs).toHaveCount(2)
			await duplicateDocument(tab('日志'))
			await page.locator('.plx-activity [aria-label="插件管理"]').click()
			await expect(tab('插件')).toBeVisible()
			await expect(page).toHaveURL(origin + basepath + '/plugins')
			await page.goBack()
			await expect(page).toHaveURL(origin + basepath + '/logs')
			await page.goForward()
			await expect(page).toHaveURL(origin + basepath + '/plugins')
		},
	)
	await check(
		'discover the actual unique workspace snapshot without copying its version',
		discoverSnapshotKey,
	)
	let inputA, inputB
	await check('real MF page, two independent instances and native rename', async () => {
		await showApps()
		await duplicateDocument(tab('应用'))
		await entry('Architecture Lab').click()
		const input = page.getByRole('textbox', { name: 'Report title', exact: true })
		await expect(input).toBeVisible()
		await expect(page).toHaveURL(origin + basepath + '/architecture-lab')
		await input.fill('Draft A survives native layout')
		inputA = await input.elementHandle()
		await rename(tab('Pluxel Architecture Lab'), 'Studio A')
		const duplicate = await duplicateDocument(tab('Studio A'), '在新标签打开副本')
		await expect(input).toHaveValue('Pluxel architecture in practice')
		await input.fill('Independent draft B')
		inputB = await input.elementHandle()
		await rename(duplicate, 'Studio B')
		await tab('Studio A').click()
		await expect(input).toHaveValue('Draft A survives native layout')
		await showApps()
		await tab('Studio A').click()
		await expect(page).toHaveURL(origin + basepath + '/architecture-lab')
		await expect(tabs).toHaveCount(6)
		assert.equal(await inputA.evaluate((element) => element.isConnected), true)
		assert.equal(await inputB.evaluate((element) => element.isConnected), true)
	})
	const retained = async () => {
		assert.deepEqual(await inputA.evaluate((element) => [element.isConnected, element.value]), [
			true,
			'Draft A survives native layout',
		])
		assert.deepEqual(await inputB.evaluate((element) => [element.isConnected, element.value]), [
			true,
			'Independent draft B',
		])
	}
	await check(
		'repeated real MF open/close restores mounted owner counts without a second socket',
		async () => {
			const content = page.locator('[data-worksplit-content]')
			const count = await content.count()
			const roots = page.locator('[data-worksplit-role="document"] input[maxlength="80"]')
			await expect(roots).toHaveCount(2)
			for (let cycle = 0; cycle < 8; cycle++) {
				const duplicate = await duplicateDocument(tab('Studio A'))
				await rename(duplicate, 'Pluxel Architecture Lab')
				await expect(tab('Pluxel Architecture Lab')).toBeVisible()
				await expect(roots).toHaveCount(3)
				const transient = await page
					.getByRole('textbox', { name: 'Report title', exact: true })
					.elementHandle()
				assert.ok(transient)
				await openMenu(tab('Pluxel Architecture Lab'))
				await menu().getByRole('menuitem', { name: '关闭标签', exact: true }).click()
				await expect(tabs).toHaveCount(6)
				await expect(content).toHaveCount(count)
				await expect(roots).toHaveCount(2)
				assert.equal(await transient.evaluate((element) => element.isConnected), false)
				await retained()
			}
			assert.equal(
				receipt.websocketPaths.filter((path) => path === '/__pluxel/runtime/session').length,
				1,
			)
			receipt.mountedOwners = { cycles: 8, mountedContents: count, mfInputs: 2 }
		},
	)
	await check('inactive context target, pin close protection and preview-free copies', async () => {
		const accepted = page.url()
		await openMenu(tab('首页'))
		await menu()
			.getByRole('menuitem', { name: '固定标签（分组中的标签会移出分组）', exact: true })
			.click()
		await expect(page).toHaveURL(accepted)
		await openMenu(tab('首页'))
		await expect(menu().getByRole('menuitem', { name: '关闭标签', exact: true })).toHaveAttribute(
			'aria-disabled',
			'true',
		)
		await page.keyboard.press('Escape')
		await retained()
	})
	const pill = page.locator('.flexlayout__group_pill')
	await check('native group create, rename, color, join, remove and fold', async () => {
		await openMenu(tab('Studio A'))
		await menu().getByRole('menuitem', { name: '加入新分组', exact: true }).click()
		await expect(pill).toHaveCount(1)
		await openMenu(pill)
		const input = page.getByRole('textbox', { name: '分组名称', exact: true })
		await input.fill('Research')
		await input.press('Enter')
		await expect(pill).toHaveAttribute('aria-label', 'Research')
		await openMenu(pill)
		const colors = menu().getByRole('button', { name: /^分组颜色 \d+$/ })
		const assertColor = async (index) => {
			const expected = await colors.nth(index).evaluate((element) => element.style.backgroundColor)
			await expect
				.poll(async () => {
					const color = nodes(await snapshot()).find(
						(node) => node.type === 'tabgroup' && node.name === 'Research',
					)?.color
					return page.evaluate((value) => {
						const element = document.createElement('span')
						element.style.color = value
						return element.style.color
					}, color)
				})
				.toBe(expected)
			await expect(menu()).toBeVisible()
		}
		await colors.first().focus()
		await page.keyboard.press('End')
		await expect(colors.last()).toBeFocused()
		await page.keyboard.press('Space')
		await assertColor(9)
		await page.keyboard.press('Home')
		for (let index = 0; index < 3; index++) await page.keyboard.press('ArrowRight')
		await expect(colors.nth(3)).toBeFocused()
		await page.keyboard.press('Enter')
		await assertColor(3)
		await page.keyboard.press('Escape')
		await openMenu(tab('Studio B'))
		await menu().getByRole('button', { name: 'Research', exact: true }).click()
		await openMenu(tab('Studio B'))
		await menu().getByRole('menuitem', { name: '移出分组', exact: true }).click()
		await openMenu(tab('Studio B'))
		await menu().getByRole('button', { name: 'Research', exact: true }).click()
		await pill.click()
		await expect(pill).toHaveAttribute('aria-expanded', 'false')
		await retained()
	})
	await check('visible close scope leaves collapsed group and pinned tab intact', async () => {
		await openMenu(tab('日志'))
		await menu().getByRole('menuitem', { name: '关闭可见且可关闭标签', exact: true }).click()
		await expect(tab('日志')).toHaveCount(0)
		await expect(tab('插件')).toHaveCount(0)
		await expect(tab('应用')).toHaveCount(0)
		await expect(pill).toHaveCount(1)
		await expect(tab('首页')).toBeVisible()
		await retained()
		if ((await pill.getAttribute('aria-expanded')) === 'false') await pill.click()
		await expect(tab('Studio A')).toBeVisible()
	})
	await check('pin promotes grouped tab into pinned run; explicit unpin and regroup', async () => {
		await openMenu(tab('Studio A'))
		await menu()
			.getByRole('menuitem', { name: '固定标签（分组中的标签会移出分组）', exact: true })
			.click()
		await expect
			.poll(async () => nodes(await snapshot()).find((node) => node.name === 'Studio A')?.pinned)
			.toBe(true)
		assert.equal(
			await tab('Studio A').evaluate((element) =>
				Boolean(element.closest('.flexlayout__tabgroup')),
			),
			false,
		)
		await openMenu(tab('Studio A'))
		await menu().getByRole('menuitem', { name: '取消固定标签', exact: true }).click()
		await openMenu(tab('Studio A'))
		await menu().getByRole('button', { name: 'Research', exact: true }).click()
		await retained()
	})
	await check('native group drag splits TabSet while retaining both MF DOM owners', async () => {
		await tab('Studio B').click()
		const id = await tab('Studio B').getAttribute('aria-controls')
		await mouseDrop(pill, page.locator(`[id="${id}"]`), 'right')
		await expect
			.poll(async () => nodes(await snapshot()).filter((node) => node.type === 'tabset').length)
			.toBe(2)
		await retained()
	})
	await check('native splitter resize and maximize/restore preserve document state', async () => {
		const splitter = page.locator('.flexlayout__splitter').last()
		const rect = await splitter.boundingBox()
		assert.ok(rect)
		await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2)
		await page.mouse.down()
		await page.mouse.move(rect.x + 50, rect.y + rect.height / 2, { steps: 10 })
		await page.mouse.up()
		await tab('Studio A').click()
		const accepted = page.url()
		await page.getByRole('button', { name: '工作区', exact: true }).click()
		await menu().getByRole('menuitem', { name: '最大化或还原活动容器', exact: true }).click()
		await expect.poll(async () => nodes(await snapshot()).some((node) => node.maximized)).toBe(true)
		await page.getByRole('button', { name: '工作区', exact: true }).click()
		await menu().getByRole('menuitem', { name: '最大化或还原活动容器', exact: true }).click()
		await expect
			.poll(async () => nodes(await snapshot()).some((node) => node.maximized))
			.toBe(false)
		await expect(page).toHaveURL(accepted)
		await retained()
	})
	await check(
		'published Border tools retain the central document URL and native activation preserves drafts',
		async () => {
			await openMenu(tab('Studio A'))
			await menu().getByRole('menuitem', { name: '移动到：标签容器 1', exact: true }).click()
			await tab('Studio A').click()
			const accepted = page.url()
			await findWorkspaceEntry('操作指南 · 左侧 · 打开')
			await expect(tab('操作指南')).toBeVisible()
			await expect(page).toHaveURL(accepted)
			await page.getByRole('tab', { name: '插件目录', exact: true }).click()
			await expect(page).toHaveURL(accepted)
			await expect(page.locator('[aria-label="插件列表与分组"]')).toBeVisible()
			await retained()
			await showApps()
			await tab('Studio A').click()
			await expect(page).toHaveURL(origin + basepath + '/architecture-lab')
			await expect(reportInput('Studio A')).toHaveValue('Draft A survives native layout')
			await retained()
		},
	)
	await check('F6 content/tab focus and context keyboard return focus', async () => {
		await tab('Studio A').focus()
		await page.keyboard.press('F6')
		const pane = page.getByRole('tabpanel', { name: 'Studio A', exact: true })
		await expect
			.poll(() => pane.evaluate((element) => element.contains(document.activeElement)))
			.toBe(true)
		const input = reportInput('Studio A')
		await input.focus()
		await expect(input).toBeFocused()
		await input.press('F6')
		await expect(tab('Studio A')).toBeFocused()
		await page.keyboard.press('Shift+F10')
		await expect(menu()).toBeVisible()
		await page.keyboard.press('Escape')
		await expect(tab('Studio A')).toBeFocused()
		await retained()
	})
	await check('light and dark theme do not reopen MF owners or leak portals', async () => {
		await page.screenshot({ path: resolve(artifacts, 'light.png') })
		await page.getByRole('button', { name: '主题设置', exact: true }).click()
		await page.getByText('深色', { exact: true }).click()
		await page.getByRole('button', { name: '主题设置', exact: true }).click()
		await expect(page.locator('html')).toHaveAttribute('data-mantine-color-scheme', 'dark')
		await openMenu(tab('Studio B'))
		await page.screenshot({ path: resolve(artifacts, 'dark-menu.png') })
		await page.keyboard.press('Escape')
		await expect(menu()).toHaveCount(0)
		await retained()
		assert.equal(
			receipt.websocketPaths.filter((path) => path === '/__pluxel/runtime/session').length,
			1,
		)
		assert.ok(
			await page
				.locator('.flexlayout__layout_metrics')
				.evaluate((element) => element.getBoundingClientRect().bottom < 0),
		)
	})
	await check(
		'refresh restores native groups, pin, Border and geometry; drafts stay transient',
		async () => {
			await expect
				.poll(async () =>
					nodes(await snapshot())
						.find((node) => node.location === 'left')
						?.children.some((node) => node.name === '操作指南'),
				)
				.toBe(true)
			const before = await snapshot()
			await page.reload()
			await expect(tab('Studio A')).toBeVisible()
			await expect(reportInput('Studio A')).toHaveValue('Pluxel architecture in practice')
			const after = await snapshot()
			const projectLayout = (value) =>
				nodes(value).map(({ id, type, name, pinned, color, opened, weight, size }) => ({
					id,
					type,
					name,
					pinned,
					color,
					opened,
					weight,
					size,
				}))
			assert.deepEqual(projectLayout(after), projectLayout(before))
		},
	)
	await check(
		'full TabSet close includes collapsed groups and retains pinned tabs elsewhere',
		async () => {
			if ((await pill.getAttribute('aria-expanded')) !== 'true') await pill.click()
			await tab('Studio B').click()
			const restoredInput = await reportInput('Studio B').elementHandle()
			assert.ok(restoredInput)
			// First activation of a lazy restored document must survive another round trip.
			const restoredDocuments = nodes(await snapshot()).filter(
				(node) => node.component === 'worksplit:document',
			).length
			await reportInput('Studio B').fill('lazy restored local draft')
			await tab('Studio A').click()
			await tab('Studio B').click()
			const returnedInput = await reportInput('Studio B').elementHandle()
			assert.ok(
				await restoredInput.evaluate(
					(element, returned) => element === returned && element.isConnected,
					returnedInput,
				),
			)
			await expect(reportInput('Studio B')).toHaveValue('lazy restored local draft')
			assert.equal(
				nodes(await snapshot()).filter((node) => node.component === 'worksplit:document').length,
				restoredDocuments,
			)
			if ((await pill.getAttribute('aria-expanded')) === 'true') await pill.click()
			await expect(pill).toHaveAttribute('aria-expanded', 'false')
			await openMenu(pill)
			await menu()
				.getByRole('menuitem', { name: '关闭整个标签容器（含折叠分组）', exact: true })
				.click()
			await expect(pill).toHaveCount(0)
			await expect
				.poll(async () => nodes(await snapshot()).filter((node) => node.type === 'tabset').length)
				.toBe(1)
			assert.equal(await restoredInput.evaluate((element) => element.isConnected), false)
			await expect(tab('首页')).toBeVisible()
			await expect(reportInput('Studio A')).toHaveValue('Pluxel architecture in practice')
		},
	)
	await check(
		'many documents and narrow viewport expose native overflow without body scroll',
		async () => {
			await duplicateDocument(tab('首页').first())
			await page.locator('.plx-activity [aria-label="插件管理"]').click()
			await expect(tab('插件')).toBeVisible()
			await expect
				.poll(async () =>
					nodes(await snapshot()).some(
						(node) => node.component === 'worksplit:document' && node.name === '插件',
					),
				)
				.toBe(true)
			const initialDocuments = nodes(await snapshot()).filter(
				(node) => node.component === 'worksplit:document',
			).length
			for (let index = 0; index < 12; index++) {
				await duplicateDocument(tab('首页').first())
				await expect
					.poll(
						async () =>
							nodes(await snapshot()).filter((node) => node.component === 'worksplit:document')
								.length,
					)
					.toBe(initialDocuments + 1 + index)
			}
			await page.setViewportSize({ width: 640, height: 480 })
			for (const name of ['左侧导航', '右侧面板', '底部面板']) {
				const control = page.getByRole('button', { name, exact: true })
				if ((await control.isEnabled()) && (await control.getAttribute('aria-pressed')) === 'true')
					await control.click()
			}
			const overflow = page.getByRole('button', { name: '查看溢出标签', exact: true }).first()
			await expect(overflow).toBeVisible()
			await overflow.click()
			await expect(menu()).toBeVisible()
			await menu().getByRole('menuitem').last().click()
			await expect(menu()).toHaveCount(0)
			assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
			await page.screenshot({ path: resolve(artifacts, 'narrow.png') })
		},
	)
	await check('unknown deep link keeps query/hash and displays an explicit error', async () => {
		const unknown = origin + basepath + '/missing/removed?query=value#section'
		await page.goto(unknown)
		await expect(page.getByText('页面不存在', { exact: true })).toBeVisible()
		await expect(page).toHaveURL(unknown)
		await page.screenshot({ path: resolve(artifacts, 'unknown.png') })
	})
	await check(
		'canonical standalone MF page owns no native workspace and ignores its snapshot',
		async () => {
			const standalone =
				origin +
				basepath +
				'/workbench-standalone/' +
				online.studioRoute +
				'/architecture-lab?view=example#section'
			await page.goto(standalone)
			await expect(page.getByRole('textbox', { name: 'Report title', exact: true })).toBeVisible()
			await expect(page.locator('.plx-workspace')).toHaveCount(0)
			await expect(page).toHaveURL(standalone)
		},
	)
	await check('corrupt restore data is preserved until explicit reset', async () => {
		await page.evaluate(({ key, value }) => localStorage.setItem(key, value), {
			key: storageKey,
			value: '{invalid snapshot',
		})
		await page.goto(origin + basepath)
		await expect(page.getByText('工作区无法恢复', { exact: true })).toBeVisible()
		assert.equal(
			await page.evaluate((key) => localStorage.getItem(key), storageKey),
			'{invalid snapshot',
		)
		await page.getByRole('button', { name: '删除保存的布局并重新打开', exact: true }).click()
		await expect(tab('首页')).toBeVisible()
		await expect(tabs).toHaveCount(1)
	})
	await check(
		'real Packages MF route reuses its document, isolates copy inputs and leaves backend unchanged',
		async () => {
			await page.setViewportSize({ width: 1440, height: 900 })
			const publication = online.layout.entries.find(
				(candidate) =>
					candidate.descriptor.owner?.exportName === 'PackageManagerPlugin' &&
					candidate.descriptor.key === 'manager',
			)
			assert.equal(publication?.placement.kind, 'route')
			assert.equal(publication.placement.path, '/packages')
			const title = publication.placement.title
			const before = await consoleRun('packageManagerSnapshot')
			await showApps()
			await duplicateDocument(tab('应用'))
			await entry(publication.placement.navigation?.label ?? title).click()
			await expect(page).toHaveURL(origin + basepath + '/packages')
			const pane = page.getByRole('tabpanel', { name: title, exact: true })
			await expect(
				pane.getByRole('heading', { name: 'Plugin packages', exact: true }),
			).toBeVisible()
			await expect(
				pane.getByRole('tab', { name: `Installed (${before.packages.length})`, exact: true }),
			).toBeVisible()
			await expect(pane.locator('tbody tr')).toHaveCount(before.packages.length)
			await pane.getByRole('tab', { name: 'Direct install', exact: true }).click()
			const input = pane.getByRole('textbox', { name: 'npm packages', exact: true })
			await expect(input).toBeEnabled()
			const packageInputA = await input.elementHandle()
			const draftA = '@pluxel/browser-draft-a@0.0.0'
			await input.fill(draftA)
			await showApps()
			await tab(title).click()
			await expect(page).toHaveURL(origin + basepath + '/packages')
			await expect(tabs).toHaveCount(3)
			await expect(input).toHaveValue(draftA)
			const reused = await input.elementHandle()
			assert.ok(await packageInputA.evaluate((element, other) => element === other, reused))
			const duplicate = await duplicateDocument(tab(title), '在右侧打开副本')
			const copyTitle = `${title}（副本）`
			await rename(duplicate, copyTitle)
			await expect(tab(copyTitle)).toBeVisible()
			const copyPane = page.getByRole('tabpanel', { name: copyTitle, exact: true })
			await copyPane.getByRole('tab', { name: 'Direct install', exact: true }).click()
			const copyInput = copyPane.getByRole('textbox', {
				name: 'npm packages',
				exact: true,
			})
			await expect(copyInput).toBeEnabled()
			await expect(copyInput).toHaveValue('')
			const packageInputB = await copyInput.elementHandle()
			assert.ok(await packageInputA.evaluate((element, other) => element !== other, packageInputB))
			const draftB = '@pluxel/browser-draft-b@0.0.0'
			await copyInput.fill(draftB)
			await tab(title).click()
			await expect(input).toHaveValue(draftA)
			await tab(copyTitle).click()
			await expect(copyInput).toHaveValue(draftB)
			await expect(input).toHaveValue(draftA)
			const after = await consoleRun('packageManagerSnapshot')
			assert.deepEqual(after, before)
			receipt.packages = {
				placement: publication.placement,
				heading: 'Plugin packages',
				draftA,
				draftB,
				reusedOriginalNode: true,
				distinctCopyNode: true,
				backendUnchanged: true,
				before,
				after,
			}
			await page.screenshot({ path: resolve(artifacts, 'packages-independent-inputs.png') })
			await tab(copyTitle).locator('[title="关闭标签"]').click()
			await expect(tab(copyTitle)).toHaveCount(0)
			assert.equal(await packageInputB.evaluate((element) => element.isConnected), false)
			await tab(title).locator('[title="关闭标签"]').click()
			await expect(tab(title)).toHaveCount(0)
			assert.equal(await packageInputA.evaluate((element) => element.isConnected), false)
			await expect(tabs).toHaveCount(2)
			await tab('应用').locator('[title="关闭标签"]').click()
			await expect(tab('首页')).toBeVisible()
			await expect(tabs).toHaveCount(1)
			assert.equal(new URL(page.url()).pathname.replace(/\/$/, ''), basepath)
		},
	)
	await check(
		'real Content panel opens, releases hidden content, closes and reopens the same panel id',
		async () => {
			await showApps()
			await duplicateDocument(tab('应用'))
			await entry('Architecture Lab').click()
			await expect(page.getByRole('textbox', { name: 'Report title', exact: true })).toBeVisible()
			const accepted = page.url()
			const publication = online.targetLayout.entries.find(
				(candidate) => candidate.descriptor.key === 'studioStatus',
			)
			assert.equal(publication?.placement.kind, 'panel')
			assert.equal(publication.placement.region, 'right')
			const label = publication.placement.label
			const heading = page.getByRole('heading', { name: '当前渲染状态', exact: true })
			await findWorkspaceEntry(`${label} · 右侧 · 打开`)
			await expect(heading).toBeVisible()
			await expect(page).toHaveURL(accepted)
			const first = await heading.elementHandle()
			assert.ok(first)
			const nativeId = await tab(label).getAttribute('aria-controls')
			const control = page.getByRole('button', { name: '右侧面板', exact: true })
			await expect(control).toHaveAttribute('aria-pressed', 'true')
			await control.click()
			await expect(heading).toHaveCount(0)
			assert.equal(await first.evaluate((element) => element.isConnected), false)
			await control.click()
			await tab(label).click()
			await expect(heading).toBeVisible()
			const restored = await heading.elementHandle()
			assert.ok(restored)
			assert.equal(await first.evaluate((element, other) => element === other, restored), false)
			await openMenu(tab(label))
			await menu().getByRole('menuitem', { name: '关闭标签', exact: true }).click()
			await expect(tab(label)).toHaveCount(0)
			await expect(heading).toHaveCount(0)
			assert.equal(await restored.evaluate((element) => element.isConnected), false)
			await findWorkspaceEntry(`${label} · 右侧 · 打开`)
			await expect(heading).toBeVisible()
			await expect(tab(label)).toHaveAttribute('aria-controls', nativeId)
			await expect(page).toHaveURL(accepted)
			receipt.contentPanel = {
				key: publication.descriptor.key,
				nativeId,
				hiddenContentUnmounted: true,
				closedContentUnmounted: true,
				sameIdReopened: true,
			}
			await page.screenshot({ path: resolve(artifacts, 'content-panel-reopened.png') })
		},
	)
	await check(
		'real dirty View refuses native and context close, then releases after approval',
		async () => {
			const publication = online.layout.entries.find(
				(candidate) =>
					candidate.descriptor.owner.exportName === 'BotWorkspacePlugin' &&
					candidate.descriptor.key === 'bot',
			)
			assert.equal(publication?.placement.kind, 'route')
			// BotStore's existing simulated support bot supplies a real editable, unsaved View.
			const path = publication.placement.path
				.replace(':source', 'telegram')
				.replace(':bot', 'support')
			assert.ok(!path.includes(':'))
			const href = origin + basepath + path
			await page.goto(href)
			const input = page.getByRole('textbox', { name: '机器人指令', exact: true })
			await expect(input).toBeEnabled()
			const original = await input.inputValue()
			const handle = await input.elementHandle()
			assert.ok(handle)
			const target = await nativeTabOf(input)
			const draft = 'Worksplit close validation: keep this local bot instruction draft.'
			await input.fill(draft)
			await expect(target.locator('[aria-label="未保存的更改"]')).toHaveCount(1)
			const rejection = '操作未完成：decision'
			const historyBefore = await notificationHistory()
			const reportsBefore = await historyBefore.filter({ hasText: rejection }).count()
			await page.getByRole('button', { name: '关闭', exact: true }).click()
			const dialog = page.getByRole('dialog').filter({ hasText: '此文档有未保存的更改' })
			await target.locator('[title="关闭标签"]').click()
			await expect(dialog).toBeVisible()
			await dialog.getByRole('button', { name: '保留文档', exact: true }).click()
			await expect(dialog).toBeHidden()
			await expect(target).toBeVisible()
			await expect(input).toHaveValue(draft)
			const nativeHistory = await notificationHistory()
			await expect(nativeHistory.filter({ hasText: rejection })).toHaveCount(reportsBefore)
			await page.getByRole('button', { name: '关闭', exact: true }).click()
			await openMenu(target)
			await menu().getByRole('menuitem', { name: '关闭标签', exact: true }).click()
			await expect(dialog).toBeVisible()
			await dialog.getByRole('button', { name: '保留文档', exact: true }).click()
			await expect(dialog).toBeHidden()
			await expect(target).toBeVisible()
			await expect(input).toHaveValue(draft)
			assert.equal(await handle.evaluate((element) => element.isConnected), true)
			const contextHistory = await notificationHistory()
			await expect(contextHistory.filter({ hasText: rejection })).toHaveCount(reportsBefore)
			await page.getByRole('button', { name: '关闭', exact: true }).click()
			const notification = page.locator('.mantine-Notification-root').filter({ hasText: rejection })
			await expect(notification).toHaveCount(0)
			await target.locator('[title="关闭标签"]').click()
			await expect(dialog).toBeVisible()
			await dialog.getByRole('button', { name: '放弃更改并继续', exact: true }).click()
			await expect(dialog).toBeHidden()
			await expect(target).toHaveCount(0)
			assert.equal(await handle.evaluate((element) => element.isConnected), false)
			await page.goto(href)
			await expect(input).toHaveValue(original)
			receipt.dirtyView = {
				key: publication.descriptor.key,
				href,
				nativeCloseRejectedWithoutReport: true,
				contextCloseRejectedWithoutFailureReport: true,
				inputRetainedUntilApproval: true,
				approvedCloseUnmounted: true,
				backendInstructionsUnchanged: true,
			}
			await page.screenshot({ path: resolve(artifacts, 'dirty-view-reopened.png') })
		},
	)
	await check('newer document navigation supersedes a slow real MF activation', async () => {
		await showApps()
		const pendingTab = await duplicateDocument(tab('应用'))
		const id = await pendingTab.getAttribute('id')
		const pendingPanel = page.locator(
			`[id=${JSON.stringify(await pendingTab.getAttribute('aria-controls'))}]`,
		)
		const before = await tabs.count()
		holdReplies = true
		try {
			await entry('Architecture Lab').click()
			await expect(page).toHaveURL(origin + basepath + '/architecture-lab')
			await expect.poll(() => delayedReplies.length).toBeGreaterThan(0)
			await page.locator('.plx-activity [aria-label="首页"]').click()
			await expect(page).toHaveURL(origin + basepath + '/')
			const releasesBeforeReply = runtimeReleases
			const heldReplies = delayedReplies.length
			releaseReplies()
			// Wait for the real late RPC roots to be disposed, rather than asserting before
			// the delayed response has reached the abandoned activation.
			await expect.poll(() => runtimeReleases).toBeGreaterThan(releasesBeforeReply)
			await expect(pendingTab).toHaveAttribute('aria-selected', 'true')
			await expect(
				pendingPanel.getByRole('textbox', { name: 'Report title', exact: true }),
			).toHaveCount(0)
			await expect(tabs).toHaveCount(before)
			await expect(page).toHaveURL(origin + basepath + '/')
			receipt.slowActivation = {
				originalTab: id,
				newerHref: basepath,
				documentCount: before,
				heldReplies,
				lateRootsReleased: runtimeReleases - releasesBeforeReply,
			}
		} finally {
			releaseReplies()
		}
	})
	if (values.lifecycle)
		await check(
			'real plugin stop withdraws epoch, destroys old MF roots and permits fresh activation',
			async () => {
				await showApps()
				await duplicateDocument(tab('应用'))
				await entry('Architecture Lab').click()
				const input = await page
					.getByRole('textbox', { name: 'Report title', exact: true })
					.elementHandle()
				assert.ok(input)
				const beforeStop = receipt.documentNavigations.length
				stopped = true
				const result = await consoleRun('stopStudio')
				assert.equal(result.current.lifecycleState, 'stopped', JSON.stringify(result))
				await expect
					.poll(async () => {
						try {
							return await input.evaluate((element) => element.isConnected)
						} catch {
							return false
						}
					})
					.toBe(false)
				await expect
					.poll(() => receipt.documentNavigations.length, { timeout: 20000 })
					.toBeGreaterThan(beforeStop)
				// The withdrawn short route is no longer in the committed directory.
				await expect(page.getByText('页面不存在', { exact: true })).toBeVisible()
				const beforeStart = receipt.documentNavigations.length
				const restarted = await consoleRun('startStudio')
				stopped = false
				assert.equal(restarted.current.lifecycleState, 'running', JSON.stringify(restarted))
				// Each epoch transition requests a full document reload; no old API root is reused.
				await expect
					.poll(() => receipt.documentNavigations.length, { timeout: 20000 })
					.toBeGreaterThan(beforeStart)
				await expect(page.getByRole('textbox', { name: 'Report title', exact: true })).toHaveValue(
					'Pluxel architecture in practice',
				)
			},
		)
	await consoleRun('health', 'inspect.ts', { origin })
	const restored = await consoleRun('default')
	assert.equal(restored.studio.lifecycleState, 'running')
	assert.deepEqual(
		restored.layout.entries.map(({ descriptor }) => descriptor.key).sort(),
		online.layout.entries.map(({ descriptor }) => descriptor.key).sort(),
	)
	receipt.publications = restored.layout.entries.map(({ descriptor, placement }) => ({
		key: descriptor.key,
		placement,
	}))
	await expect(page.locator('.plx-workspace__update-status')).toHaveText(/^HMR (?:已应用|就绪)$/)
	receipt.hmr = await page.locator('.plx-workspace__update-status').innerText()
	await check('the final live document owns exactly one runtime session socket', async () => {
		await expect.poll(() => runtimeSockets.size).toBe(1)
		assert.ok(receipt.runtimeSessionDocuments.every((document) => document.opened === 1))
		receipt.activeRuntimeSockets = runtimeSockets.size
	})
	assert.deepEqual(receipt.errors, [])
	assert.deepEqual(receipt.resourceFailures, [])
	receipt.ok = true
} catch (error) {
	receipt.ok = false
	receipt.failure = error.stack ?? String(error)
	receipt.nativeTabs = await tabs
		.evaluateAll((elements) =>
			elements.map((element) => ({
				label: element.getAttribute('aria-label'),
				selected: element.getAttribute('aria-selected'),
			})),
		)
		.catch(() => [])
	await page.screenshot({ path: resolve(artifacts, 'failure.png') }).catch(() => {})
	console.error(receipt.failure)
	process.exitCode = 1
} finally {
	releaseReplies()
	if (stopped)
		await consoleRun('startStudio').catch((error) => {
			receipt.restoreFailure = String(error)
			process.exitCode = 1
		})
	await writeFile(resolve(artifacts, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
	await context.close()
	await browser.close()
	console.log(`Receipt: ${resolve(artifacts, 'receipt.json')}`)
}
