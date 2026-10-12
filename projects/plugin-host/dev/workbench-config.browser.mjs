import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, promisify } from 'node:util'
import { chromium, expect } from 'playwright/test'

// Real ConfigForm drafts only. Backend reads use the selected existing dev console.
const { values } = parseArgs({
	options: {
		origin: { type: 'string' },
		root: { type: 'string' },
		instance: { type: 'string' },
		executable: { type: 'string' },
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
async function consoleRead(file) {
	const { stdout } = await command(
		process.execPath,
		[
			resolve(repository, 'packages/cli/bin/pluxel.mjs'),
			'dev',
			'run',
			resolve(project, 'dev', file),
			'--root',
			values.root,
			'--instance',
			values.instance,
		],
		{ cwd: repository, maxBuffer: 2 ** 22 },
	)
	const result = JSON.parse(stdout)
	assert.equal(result.ok, true, JSON.stringify(result))
	assert.equal(result.value.state, 'succeeded', JSON.stringify(result.value))
	receipt.console.push({
		file,
		runId: result.value.runId,
		hostEpoch: result.value.hostEpoch,
		value: result.value.value,
	})
	return result.value.value
}
async function check(name, run) {
	const evidence = await run()
	receipt.checks.push({ name, evidence })
	console.log(`PASS ${name}`)
}
const browser = await chromium.launch({
	headless: true,
	...(values.executable ? { executablePath: values.executable } : {}),
})
const context = await browser.newContext({
	viewport: { width: 1280, height: 850 },
	colorScheme: 'light',
})
const page = await context.newPage()
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
	assert.equal(configBefore.ok, true)
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
		'Save is intentionally not invoked. Configuration persistence and save failures are outside this draft acceptance.',
	)
	let detailTab, panel, original, originalHandle, draft, detailUrl
	await check(
		'real published MF loads before canonical catalog detail and late Mantine panel sizing',
		async () => {
			await page.goto(origin + basepath + studioEntry.placement.path)
			await expect(page.getByRole('textbox', { name: 'Report title', exact: true })).toBeVisible()
			await page
				.locator('.plx-workspace-navigation__link')
				.filter({ hasText: '插件目录与配置' })
				.click()
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
	await check(
		'MF/native document and local detail query tab switches retain real form',
		async () => {
			await page.getByRole('tab', { name: studioEntry.placement.title, exact: true }).click()
			await expect(page.getByRole('textbox', { name: 'Report title', exact: true })).toBeVisible()
			assert.ok(await originalHandle.evaluate((node) => node.isConnected))
			await detailTab.click()
			await assertInputIdentity(originalHandle, pathInput(panel), draft)
			await panel.getByRole('tab', { name: '概览', exact: true }).click()
			await panel.getByRole('tab', { name: '配置', exact: true }).click()
			await assertInputIdentity(originalHandle, pathInput(panel), draft)
			await expect(detailTab.locator('[aria-label="未保存的更改"]')).toHaveCount(1)
			return {
				draft,
				sameNode: true,
				query: new URL(page.url()).search,
				panels: await assertPanels(panel),
			}
		},
	)
	let copyTab, copyPanel, copyHandle, copyDraft
	await check(
		'native right-side detail copy has independent ConfigForm defaults drafts and anchor IDs',
		async () => {
			await detailTab.click({ button: 'right' })
			await page.getByRole('menuitem', { name: '在右侧打开副本', exact: true }).click()
			const name = await detailTab.getAttribute('aria-label')
			copyTab = page.getByRole('tab', { name: `${name}（副本）`, exact: true })
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
			await page.setViewportSize({ width: 1280, height: 420 })
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
	await check('backend saved configuration is unchanged and browser has no errors', async () => {
		const configAfter = await consoleRead('workbench-config.ts')
		assert.deepEqual(configAfter, configBefore)
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
	await browser.close()
	await writeFile(resolve(artifacts, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
}
