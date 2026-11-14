import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, promisify } from 'node:util'
import { chromium, expect } from 'playwright/test'

// Real ConfigForm acceptance. --save exercises acknowledged persistence and restores its one field through the selected dev console.
const { values } = parseArgs({
	options: {
		origin: { type: 'string' },
		root: { type: 'string' },
		instance: { type: 'string' },
		'ws-endpoint': { type: 'string' },
		save: { type: 'boolean', default: false },
		artifacts: { type: 'string', default: '/tmp/pluxel-workbench-config-browser' },
	},
})
if (!values.origin || !values.root || !values.instance)
	throw new Error(
		'Required: --origin URL --root ABSOLUTE_PROJECT_ROOT --instance DISCOVERED_INSTANCE_ID',
	)
const project = fileURLToPath(new URL('../', import.meta.url))
const repository = fileURLToPath(new URL('../../../', import.meta.url))
assert.equal(resolve(values.root), resolve(project))
const origin = new URL(values.origin).origin
const basepath = '/__pluxel/workbench'
const artifacts = resolve(values.artifacts)
await mkdir(artifacts, { recursive: true })
const receipt = {
	origin,
	root: values.root,
	instance: values.instance,
	checks: [],
	console: [],
	errors: [],
	resourceFailures: [],
	boundaries: [],
}
const command = promisify(execFile)
async function consoleRead(file, exportName = 'default', input) {
	const { stdout, stderr } = await command(
		process.execPath,
		[
			resolve(repository, 'packages/cli/bin/pluxel.mjs'),
			'dev',
			'run',
			resolve(project, 'dev', file),
			'--export',
			exportName,
			...(input === undefined ? [] : ['--input', JSON.stringify(input)]),
			'--root',
			values.root,
			'--instance',
			values.instance,
		],
		{ cwd: repository, maxBuffer: 2 ** 22 },
	)
	const result = JSON.parse(stdout)
	const accepted = stderr
		.trim()
		.split('\n')
		.map((line) => JSON.parse(line))
		.find((event) => event.event === 'accepted')
	assert.ok(accepted?.receipt)
	assert.equal(result.ok, true, JSON.stringify(result))
	assert.equal(result.value.state, 'succeeded', JSON.stringify(result.value))
	assert.equal(result.value.value.status, 'ok', JSON.stringify(result.value.value))
	receipt.console.push({
		file,
		exportName,
		receipt: accepted.receipt,
		runId: result.value.runId,
		hostEpoch: result.value.hostEpoch,
		value: result.value.value,
	})
	return result.value.value.value
}
async function check(name, run) {
	const evidence = await run()
	receipt.checks.push({ name, evidence })
	console.log(`PASS ${name}`)
}
const browser = await chromium.connect(
	values['ws-endpoint'] ?? process.env.PLAYWRIGHT_WS_ENDPOINT ?? 'ws://127.0.0.1:3000',
	{ exposeNetwork: '<loopback>' },
)
const context = await browser.newContext({
	viewport: { width: 1280, height: 850 },
	colorScheme: 'light',
})
const page = await context.newPage()
let holdReplies = false
const delayedReplies = []
await page.routeWebSocket('**/__pluxel/runtime/session', (socket) => {
	const server = socket.connectToServer()
	server.onMessage((message) => {
		if (holdReplies) delayedReplies.push(() => socket.send(message))
		else socket.send(message)
	})
})
const releaseReplies = () => {
	holdReplies = false
	for (const send of delayedReplies.splice(0)) send()
}
let restoreInput
let savedConfigBefore
page.setDefaultTimeout(20000)
page.on('pageerror', (error) => receipt.errors.push(error.message))
page.on('console', (message) => {
	if (message.type() === 'error') receipt.errors.push(message.text())
})
page.on('response', (response) => {
	if (response.status() >= 400)
		receipt.resourceFailures.push({ url: response.url(), status: response.status() })
})
const panelOf = async (tab) => page.locator(`[id="${await tab.getAttribute('aria-controls')}"]`)
const pathInput = (panel) => panel.getByRole('textbox', { name: '出站探测路径', exact: true })
async function assertPanels(panel) {
	const dimensions = await panel.locator('.plx-pluginDocument__panel').evaluateAll((nodes) =>
		nodes.map((node) => ({
			id: node.id,
			display: getComputedStyle(node).display,
			flex: getComputedStyle(node).flex,
			height: node.clientHeight,
			scrollHeight: node.scrollHeight,
		})),
	)
	const visible = dimensions.filter((node) => node.display !== 'none')
	assert.equal(visible.length, 1)
	assert.ok(visible[0].height > 100, `Config panel collapsed: ${JSON.stringify(dimensions)}`)
	assert.equal(visible[0].flex, '1 1 0%')
	assert.ok(dimensions.filter((node) => node.display === 'none').every((node) => node.height === 0))
	return dimensions
}
async function assertInputIdentity(handle, input, expected) {
	const current = await input.elementHandle()
	assert.ok(await handle.evaluate((node, other) => node.isConnected && node === other, current))
	assert.equal(await handle.inputValue(), expected)
}
try {
	const online = await consoleRead('workbench.ts')
	assert.equal(online.studio.lifecycleState, 'running')
	const configBefore = await consoleRead('workbench-config.ts')
	savedConfigBefore = configBefore
	const studioEntry = online.layout.entries.find((entry) => entry.descriptor.key === 'studio')
	assert.equal(studioEntry?.placement.kind, 'route')
	assert.equal(studioEntry.placement.frame, 'shell')
	receipt.publications = online.layout.entries.map((entry) => ({
		key: entry.descriptor.key,
		route: entry.placement.kind === 'route' ? entry.placement : null,
	}))
	const standalone = receipt.publications.filter((entry) => entry.route?.frame === 'standalone')
	receipt.boundaries.push(
		standalone.length === 0
			? 'No standalone page is published by this Host; full-workspace leave cancellation is not verified here.'
			: 'This script verifies native document closure, not the published standalone entrance.',
	)
	receipt.boundaries.push(
		values.save
			? 'Save uses the real Host; only WebSocket replies are held to expose the pending acknowledgement interval. The changed outboundPath is restored through its dev console.'
			: 'Save is not invoked without --save; this run covers drafts only.',
	)
	let detailTab, panel, original, originalHandle, draft, detailUrl
	await check(
		'real published MF loads before canonical catalog detail and late Mantine panel sizing',
		async () => {
			await page.goto(origin + basepath + studioEntry.placement.path)
			await expect(page.getByRole('textbox', { name: 'Report title', exact: true })).toBeVisible()
			await page
				.locator('.flexlayout__tab_button[aria-selected=true]')
				.getByRole('button', { name: '复制当前标签页', exact: true })
				.click()
			await page.locator('.plx-activity [aria-label="插件管理"]').click()
			await page.getByRole('textbox', { name: '搜索插件', exact: true }).fill('Report')
			const href = `${basepath}/plugins/${online.studioRoute}`
			const owner = page.locator('a').filter({ hasText: online.studio.displayName })
			await expect(owner).toHaveAttribute('href', href)
			await owner.click()
			await expect(page).toHaveURL(origin + href)
			detailTab = page.locator('.flexlayout__tab_button[aria-selected=true]')
			detailTab = page.locator(`[id="${await detailTab.getAttribute('id')}"]`)
			panel = await panelOf(detailTab)
			await expect(pathInput(panel)).toBeVisible()
			original = await pathInput(panel).inputValue()
			originalHandle = await pathInput(panel).elementHandle()
			detailUrl = page.url()
			return { canonicalHref: href, original, panels: await assertPanels(panel) }
		},
	)
	await check(
		'real ConfigForm dirty close cancellation retains DOM draft and native dirty status',
		async () => {
			draft = '/status/202?draft=flexlayout-local'
			await pathInput(panel).fill(draft)
			await expect(detailTab.locator('[aria-label="未保存的更改"]')).toHaveCount(1)
			await detailTab.locator('[title="关闭标签"]').click()
			const dialog = page.getByRole('dialog').filter({ hasText: '此文档有未保存的更改' })
			await expect(dialog).toBeVisible()
			await page.screenshot({ path: resolve(artifacts, '01-real-close-confirm.png') })
			await dialog.getByRole('button', { name: '保留文档', exact: true }).click()
			await expect(dialog).toBeHidden()
			await expect(detailTab).toBeVisible()
			await expect(page).toHaveURL(detailUrl)
			await assertInputIdentity(originalHandle, pathInput(panel), draft)
			await expect(detailTab.locator('[aria-label="未保存的更改"]')).toHaveCount(1)
			await page.screenshot({ path: resolve(artifacts, '02-real-config-retained.png') })
			return { draft, originalNodeRetained: true, dirty: true, url: page.url() }
		},
	)
	await check('browser back retains the real dirty document after navigation refusal', async () => {
		const dialog = page.getByRole('dialog').filter({ hasText: '此文档有未保存的更改' })
		await page.goBack()
		await expect(dialog).toBeVisible()
		await dialog.getByRole('button', { name: '保留文档', exact: true }).click()
		await expect(dialog).toBeHidden()
		await expect(page).toHaveURL(detailUrl)
		await assertInputIdentity(originalHandle, pathInput(panel), draft)
		await expect(detailTab.locator('[aria-label="未保存的更改"]')).toHaveCount(1)
		return { refusedHistory: true, sameDocumentAndDraft: true }
	})
	await check(
		'MF/native document switches and plugin tool hide/show retain real form',
		async () => {
			await page.getByRole('tab', { name: studioEntry.placement.title, exact: true }).click()
			await expect(page.getByRole('textbox', { name: 'Report title', exact: true })).toBeVisible()
			assert.ok(await originalHandle.evaluate((node) => node.isConnected))
			await detailTab.click()
			await assertInputIdentity(originalHandle, pathInput(panel), draft)
			for (const [controlName, toolName] of [['右侧面板', '当前插件信息']]) {
				const control = page.getByRole('button', { name: controlName, exact: true })
				const tool = page.locator(`section[aria-label="${toolName}"]`)
				await expect(control).toHaveAttribute('aria-pressed', 'false')
				await expect(tool).toBeHidden()
				await control.click()
				await expect(control).toHaveAttribute('aria-pressed', 'true')
				await expect(tool).toBeVisible()
				await control.click()
				await expect(control).toHaveAttribute('aria-pressed', 'false')
				await expect(tool).toBeHidden()
				await assertInputIdentity(originalHandle, pathInput(panel), draft)
				await control.click()
				await expect(control).toHaveAttribute('aria-pressed', 'true')
				await expect(tool).toBeVisible()
				await assertInputIdentity(originalHandle, pathInput(panel), draft)
			}
			await page.getByRole('tab', { name: '最近日志', exact: true }).click()
			await expect(page.locator('section[aria-label="插件最近日志面板"]')).toBeVisible()
			await page.getByRole('tab', { name: '插件信息', exact: true }).click()
			await assertInputIdentity(originalHandle, pathInput(panel), draft)
			await expect(page).toHaveURL(detailUrl)
			await expect(detailTab.locator('[aria-label="未保存的更改"]')).toHaveCount(1)
			return {
				draft,
				sameNode: true,
				toolsRestored: ['inspector', 'logs'],
				url: page.url(),
				panels: await assertPanels(panel),
			}
		},
	)
	let copyTab, copyPanel, copyHandle, copyDraft
	await check(
		'native right-side detail copy has independent ConfigForm defaults drafts and anchor IDs',
		async () => {
			const previousTabIds = await page
				.locator('.flexlayout__tab_button')
				.evaluateAll((nodes) => nodes.map((node) => node.id))
			await detailTab.click({ button: 'right' })
			await page.getByRole('menuitem', { name: '在右侧打开副本', exact: true }).click()
			await expect
				.poll(() => page.locator('.flexlayout__tab_button').count())
				.toBe(previousTabIds.length + 1)
			const added = await page
				.locator('.flexlayout__tab_button')
				.evaluateAll(
					(nodes, before) => nodes.map((node) => node.id).filter((id) => !before.includes(id)),
					previousTabIds,
				)
			assert.equal(added.length, 1)
			copyTab = page.locator(`[id=${JSON.stringify(added[0])}]`)
			await expect(copyTab).toBeVisible()
			copyPanel = await panelOf(copyTab)
			await expect(pathInput(copyPanel)).toHaveValue(original)
			copyHandle = await pathInput(copyPanel).elementHandle()
			assert.ok(await originalHandle.evaluate((node, other) => node !== other, copyHandle))
			copyDraft = '/status/203?draft=independent-copy'
			await pathInput(copyPanel).fill(copyDraft)
			await assertInputIdentity(originalHandle, pathInput(panel), draft)
			await assertInputIdentity(copyHandle, pathInput(copyPanel), copyDraft)
			const ids = await panel
				.locator('[data-config-anchor]')
				.evaluateAll((nodes) => nodes.map((node) => node.id))
			const copyIds = await copyPanel
				.locator('[data-config-anchor]')
				.evaluateAll((nodes) => nodes.map((node) => node.id))
			assert.ok(ids.length >= 2 && copyIds.length >= 2)
			assert.ok(ids.every((id) => !copyIds.includes(id)))
			await expect(copyTab.locator('[aria-label="未保存的更改"]')).toHaveCount(1)
			await assertPanels(panel)
			await assertPanels(copyPanel)
			await page.screenshot({ path: resolve(artifacts, '03-independent-real-config-copies.png') })
			return { original, draft, copyDraft, ids, copyIds, distinctNodes: true }
		},
	)
	await check(
		'short split documents retain bounded viewports and each TOC scrolls its own form',
		async () => {
			await page.setViewportSize({ width: 1280, height: 330 })
			for (const name of ['左侧导航', '右侧面板', '底部面板']) {
				const control = page.getByRole('button', { name, exact: true })
				if ((await control.getAttribute('aria-pressed')) === 'true') await control.click()
			}
			await copyPanel.getByRole('button', { name: '配置目录', exact: true }).click()
			const firstScroll = await panel.locator('[data-config-scroll-root]').first().elementHandle()
			const copyScroll = await copyPanel
				.locator('[data-config-scroll-root]')
				.first()
				.elementHandle()
			await expect
				.poll(() => firstScroll.evaluate((node) => node.scrollHeight - node.clientHeight))
				.toBeGreaterThan(15)
			await expect
				.poll(() => copyScroll.evaluate((node) => node.scrollHeight - node.clientHeight))
				.toBeGreaterThan(15)
			await firstScroll.evaluate((node) => {
				node.scrollTop = 15
			})
			await copyScroll.evaluate((node) => {
				node.scrollTop = 0
			})
			const dimensions = (node) => ({
				top: node.scrollTop,
				height: node.clientHeight,
				scrollHeight: node.scrollHeight,
			})
			const before = await firstScroll.evaluate(dimensions)
			assert.equal(before.top, 15)
			await copyPanel.getByRole('button', { name: '出站探测路径', exact: true }).click()
			await expect.poll(() => copyScroll.evaluate((node) => node.scrollTop)).toBeGreaterThan(0)
			await page.waitForTimeout(650)
			const after = await firstScroll.evaluate(dimensions)
			const copied = await copyScroll.evaluate(dimensions)
			assert.equal(after.top, before.top)
			assert.ok(copied.height > 0 && copied.scrollHeight > copied.height)
			const containment = await copyScroll.evaluate((node) => {
				const viewport = node.getBoundingClientRect()
				const owner = node.closest('.plx-pluginDocument__panel').getBoundingClientRect()
				return { top: viewport.top >= owner.top, bottom: viewport.bottom <= owner.bottom }
			})
			assert.deepEqual(containment, { top: true, bottom: true })
			await assertInputIdentity(originalHandle, pathInput(panel), draft)
			await assertInputIdentity(copyHandle, pathInput(copyPanel), copyDraft)
			await assertPanels(panel)
			await assertPanels(copyPanel)
			await page.screenshot({ path: resolve(artifacts, '04-owned-toc-bounded-scroll.png') })
			return { before, after, copied, containment }
		},
	)
	await check('batch close cancellation preserves both real dirty documents', async () => {
		await page.getByRole('button', { name: '工作区', exact: true }).click()
		await page.getByRole('menuitem', { name: '关闭所有文档（保留布局）', exact: true }).click()
		const all = page.getByRole('dialog').filter({ hasText: '将关闭全部文档' })
		await all.getByRole('button', { name: '关闭所有文档', exact: true }).click()
		const dirty = page.getByRole('dialog').filter({ hasText: '此文档有未保存的更改' })
		await expect(dirty).toBeVisible()
		await dirty.getByRole('button', { name: '保留文档', exact: true }).click()
		await expect(dirty).toBeHidden()
		await assertInputIdentity(originalHandle, pathInput(panel), draft)
		await assertInputIdentity(copyHandle, pathInput(copyPanel), copyDraft)
	})
	if (values.save)
		await check(
			'real save acknowledgement, pending-write refusal and edits made during save',
			async () => {
				await page.setViewportSize({ width: 1440, height: 900 })
				await detailTab.click()
				restoreInput = {
					hadOverride: Object.hasOwn(configBefore.managedInput ?? {}, 'outboundPath'),
					value: configBefore.managedInput?.outboundPath,
				}
				holdReplies = true
				await panel.getByRole('button', { name: '保存', exact: true }).click()
				await expect(panel.getByRole('button', { name: '保存', exact: true })).toBeDisabled()
				const newer = '/status/205?draft=typed-during-save'
				await pathInput(panel).fill(newer)
				await detailTab.locator('[title="关闭标签"]').click()
				await expect(detailTab).toBeVisible()
				await expect(
					page.getByRole('dialog').filter({ hasText: '此文档有未保存的更改' }),
				).toHaveCount(0)
				await assertInputIdentity(originalHandle, pathInput(panel), newer)
				assert.ok(delayedReplies.length > 0, 'Actual Host replies were held during this save')
				releaseReplies()
				await expect(panel.getByRole('button', { name: '保存', exact: true })).toBeEnabled()
				await assertInputIdentity(originalHandle, pathInput(panel), newer)
				await expect(detailTab.locator('[aria-label="未保存的更改"]')).toHaveCount(1)
				const saved = await consoleRead('workbench-config.ts')
				assert.equal(saved.managedInput.outboundPath, draft)
				// This sample has no config update listener; persisted input is explicit about that boundary.
				assert.equal(saved.application, 'saved-not-applied')
				assert.ok(saved.desiredRevision > saved.appliedRevision)
				await expect(page.getByText('配置已保存，但尚未应用', { exact: true })).toBeVisible()
				await page.screenshot({ path: resolve(artifacts, '05-save-ack-preserves-newer-edit.png') })
				const restored = await consoleRead(
					'workbench-config.ts',
					'restoreOutboundPath',
					restoreInput,
				)
				assert.equal(restored.application, 'applied')
				restoreInput = undefined
				return {
					savedPath: draft,
					retainedDraft: newer,
					pendingCloseRefused: true,
					application: saved.application,
					backendRestored: true,
				}
			},
		)
	await check('backend saved configuration is unchanged and browser has no errors', async () => {
		const configAfter = await consoleRead('workbench-config.ts')
		for (const key of ['managedInput', 'effectiveInput', 'config'])
			assert.deepEqual(configAfter[key], configBefore[key])
		assert.deepEqual(receipt.errors, [])
		assert.deepEqual(receipt.resourceFailures, [])
		return {
			desiredRevision: configAfter.desiredRevision,
			appliedRevision: configAfter.appliedRevision,
			configurationUnchanged: true,
		}
	})
} catch (error) {
	receipt.failure = error.stack ?? String(error)
	await page.screenshot({ path: resolve(artifacts, 'failure.png') }).catch(() => {})
	process.exitCode = 1
} finally {
	releaseReplies()
	if (restoreInput) {
		try {
			const restored = await consoleRead('workbench-config.ts', 'restoreOutboundPath', restoreInput)
			for (const key of ['managedInput', 'effectiveInput', 'config'])
				assert.deepEqual(restored[key], savedConfigBefore[key])
			receipt.restoredAfterFailure = true
		} catch (error) {
			receipt.restoreFailure = String(error)
			process.exitCode = 1
		}
	}
	await context.close()
	await browser.close()
	await writeFile(resolve(artifacts, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
}
