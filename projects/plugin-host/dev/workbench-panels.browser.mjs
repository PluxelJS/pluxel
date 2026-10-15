import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, promisify } from 'node:util'
import { chromium, expect } from 'playwright/test'

const { values } = parseArgs({
	options: {
		origin: { type: 'string' },
		root: { type: 'string' },
		instance: { type: 'string' },
		executable: { type: 'string' },
		artifacts: { type: 'string', default: '/tmp/pluxel-workbench-panels-browser' },
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
	errors: [],
	console: [],
	websocketPaths: [],
	boundaries: [
		'Read-only browser acceptance: no report is generated or backend state mutated.',
		'The existing console exposes domain snapshots and publications, not active panel subscription counts. DOM unmount and fresh mount are verified separately.',
	],
}
const command = promisify(execFile)
async function inspect() {
	const { stdout } = await command(
		process.execPath,
		[
			resolve(repository, 'packages/cli/bin/pluxel.mjs'),
			'dev',
			'run',
			resolve(project, 'dev/workbench.ts'),
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
	receipt.console.push({ runId: result.value.runId, hostEpoch: result.value.hostEpoch })
	return result.value.value
}
async function check(name, run) {
	await run()
	receipt.checks.push(name)
	console.log(`PASS ${name}`)
}
const browser = await chromium.launch({
	headless: true,
	...(values.executable ? { executablePath: values.executable } : {}),
})
const context = await browser.newContext({
	viewport: { width: 1440, height: 1000 },
	colorScheme: 'light',
})
const page = await context.newPage()
page.setDefaultTimeout(20000)
page.on('pageerror', (error) => receipt.errors.push(error.message))
page.on('websocket', (socket) => receipt.websocketPaths.push(new URL(socket.url()).pathname))
page.on('console', (message) => {
	if (message.type() === 'error') receipt.errors.push(message.text())
})
const regions = [
	{
		key: 'studioGuide',
		region: 'left',
		label: '操作指南',
		heading: '报表工作流',
		list: '插件导航',
		control: '左侧导航',
	},
	{
		key: 'studioStatus',
		region: 'right',
		label: '渲染状态',
		heading: '当前渲染状态',
		list: '插件信息视图',
		control: '右侧面板',
	},
	{
		key: 'studioArtifacts',
		region: 'bottom',
		label: '最近产物',
		heading: '最近产物',
		list: '插件底部视图',
		control: '底部面板',
	},
]
const heading = (region) =>
	page.getByRole('heading', { name: region.heading, exact: true, includeHidden: true })
async function select(region) {
	const control = page.getByRole('button', { name: region.control, exact: true })
	if ((await control.getAttribute('aria-pressed')) !== 'true') await control.click()
	if (region.region !== 'left')
		await page
			.getByRole('tablist', { name: region.list, exact: true })
			.getByRole('tab', { name: region.label, exact: true })
			.click()
	await expect(heading(region)).toBeVisible()
}
try {
	const before = await inspect()
	const studio = before.layout.entries.find((entry) => entry.descriptor.key === 'studio')
	assert.equal(studio?.placement.kind, 'route')
	for (const region of regions) {
		const publication = before.targetLayout.entries.find(
			(entry) => entry.descriptor.key === region.key,
		)
		assert.deepEqual(publication?.placement, {
			kind: 'panel',
			region: region.region,
			label: region.label,
			order: 10,
		})
		assert.deepEqual(publication.target.node, before.studio.address)
	}
	await page.goto(origin + basepath + studio.placement.path)
	await expect(page.getByRole('textbox', { name: 'Report title', exact: true })).toBeVisible()
	const documentUrl = page.url()
	await check(
		'three real Content panels render without changing the active document URL',
		async () => {
			for (const region of regions) {
				await select(region)
				await expect(page).toHaveURL(documentUrl)
			}
			const status = page.getByRole('tabpanel', { name: '渲染状态', exact: true })
			await expect(status).toContainText(before.snapshot.engines.join(' · '))
			await expect(status).toContainText(before.snapshot.storageProvider)
			const recent = page.getByRole('tabpanel', { name: '最近产物', exact: true })
			for (const artifact of before.snapshot.artifacts)
				await expect(recent).toContainText(artifact.title)
			await expect(status.locator('.plx-documentOutline')).toBeHidden()
			assert.ok(
				await status
					.locator('.plx-workbenchContent__dataGrid dd')
					.first()
					.evaluate((node) => node.getBoundingClientRect().width >= 200),
				'Narrow panel values must retain readable width',
			)
			await page.mouse.move(400, 18)
			await page.waitForTimeout(400)
			await page.screenshot({ path: resolve(artifacts, 'panels-open.png') })
		},
	)
	await check(
		'hiding each region unmounts its panel and reopening creates fresh content',
		async () => {
			for (const region of regions) {
				const original = await heading(region).elementHandle()
				assert.ok(original)
				const control = page.getByRole('button', { name: region.control, exact: true })
				await control.click()
				await expect(heading(region)).toHaveCount(0)
				assert.equal(await original.evaluate((node) => node.isConnected), false)
				await control.click()
				await expect(heading(region)).toBeVisible()
				await expect(page).toHaveURL(documentUrl)
			}
		},
	)
	await check(
		'official Home clears plugin panels and returning opens the current owner panels',
		async () => {
			const prior = await Promise.all(regions.map((region) => heading(region).elementHandle()))
			await page.locator('.plx-activity [aria-label="首页"]').click()
			for (const region of regions) await expect(heading(region)).toHaveCount(0)
			for (const handle of prior)
				assert.equal(await handle.evaluate((node) => node.isConnected), false)
			await page.getByRole('tab', { name: studio.placement.title, exact: true }).click()
			await expect(page).toHaveURL(documentUrl)
			for (const region of regions) await select(region)
			await page.screenshot({ path: resolve(artifacts, 'panels-returned.png') })
		},
	)
	await check(
		'applications and plugin management have separate navigation, with no empty application sidebar',
		async () => {
			await page.locator('.plx-activity [aria-label="应用"]').click()
			await expect(page).toHaveURL(origin + basepath + '/apps')
			await expect(page.locator('.plx-plugin-region:visible')).toHaveCount(0)
			await expect(page.locator('[aria-label*="：在新标签打开副本"]')).toHaveCount(0)
			await page.screenshot({ path: resolve(artifacts, 'applications.png') })
			await page
				.locator('.plx-workspace-navigation:visible')
				.getByRole('button', { name: 'Packages', exact: true })
				.click()
			await expect(
				page.getByRole('heading', { name: 'Managed plugin packages', exact: true }),
			).toBeVisible()
			await expect(page.getByRole('button', { name: '左侧导航', exact: true })).toBeDisabled()
			await expect(page.getByRole('button', { name: '左侧导航', exact: true })).toHaveAttribute(
				'aria-pressed',
				'false',
			)
			await page.locator('.plx-activity [aria-label="插件管理"]').click()
			await expect(page).toHaveURL(origin + basepath + '/plugins')
			await expect(
				page
					.locator('.plx-workspace-navigation:visible')
					.getByRole('button', { name: '插件管理', exact: true }),
			).toBeVisible()
			await expect(page.getByRole('tab', { name: '插件页面', exact: true })).toHaveCount(0)
		},
	)
	const after = await inspect()
	assert.deepEqual(after.snapshot, before.snapshot)
	assert.deepEqual(receipt.errors, [])
	assert.equal(
		receipt.websocketPaths.filter((path) => path === '/__pluxel/runtime/session').length,
		1,
	)
	receipt.publications = regions
	receipt.ok = true
} catch (error) {
	receipt.ok = false
	receipt.failure = error.stack ?? String(error)
	console.error(receipt.failure)
	await page.screenshot({ path: resolve(artifacts, 'failure.png') }).catch(() => {})
	process.exitCode = 1
} finally {
	await writeFile(resolve(artifacts, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
	await browser.close()
}
