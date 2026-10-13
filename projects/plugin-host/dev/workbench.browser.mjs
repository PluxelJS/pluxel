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
		executable: { type: 'string' },
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
const storageKey = `pluxel:worksplit:4:${basepath}`
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
	const { stdout } = await command(process.execPath, args, { cwd: repository, maxBuffer: 2 ** 22 })
	const result = JSON.parse(stdout)
	assert.equal(result.ok, true, JSON.stringify(result))
	assert.equal(result.value.state, 'succeeded', JSON.stringify(result.value))
	receipt.console ??= []
	receipt.console.push({
		exportName,
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
const browser = await chromium.launch({
	headless: true,
	...(values.executable ? { executablePath: values.executable } : {}),
})
const context = await browser.newContext({
	viewport: { width: 1440, height: 900 },
	colorScheme: 'light',
})
const page = await context.newPage()
page.setDefaultTimeout(20000)
page.on('pageerror', (error) => receipt.errors.push(error.message))
page.on('websocket', (socket) => receipt.websocketPaths.push(new URL(socket.url()).pathname))
page.on('request', (request) => {
	if (request.isNavigationRequest() && request.frame() === page.mainFrame())
		receipt.documentNavigations.push(new URL(request.url()).pathname)
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
const snapshot = () => page.evaluate((key) => JSON.parse(localStorage.getItem(key)), storageKey)
async function showApps() {
	await page.locator('.plx-activity [aria-label="应用"]').click()
	await expect(page).toHaveURL(origin + basepath + '/apps')
	await expect(navigation).toHaveCount(1)
	await expect(navigation).toBeVisible()
}
async function newDocument(label) {
	await page.getByRole('button', { name: '新建标签页', exact: true }).click()
	const dialog = page.getByRole('dialog', { name: '新建标签页', exact: true })
	await expect(dialog).toBeVisible()
	await dialog.locator('.plx-workspace-navigation__link').filter({ hasText: label }).click()
	await expect(dialog).toHaveCount(0)
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
	await check('two built-ins, same URL reuse, browser back/forward and basepath', async () => {
		await page.goto(origin + basepath)
		await expect(tab('首页')).toBeVisible()
		await page.locator('.plx-activity [aria-label="日志"]').click()
		await expect(tab('日志')).toBeVisible()
		await expect(page).toHaveURL(origin + basepath + '/logs')
		await page.locator('.plx-activity [aria-label="日志"]').click()
		await expect(tabs).toHaveCount(2)
		await page.locator('.plx-activity [aria-label="插件管理"]').click()
		await navigation.getByRole('button', { name: '插件管理', exact: true }).click()
		await expect(tab('插件')).toBeVisible()
		await expect(page).toHaveURL(origin + basepath + '/plugins')
		await page.goBack()
		await expect(page).toHaveURL(origin + basepath + '/logs')
		await page.goForward()
		await expect(page).toHaveURL(origin + basepath + '/plugins')
	})
	let inputA, inputB
	await check('real MF page, two independent instances and native rename', async () => {
		await showApps()
		await entry('Architecture Lab').click()
		const input = page.getByRole('textbox', { name: 'Report title', exact: true })
		await expect(input).toBeVisible()
		await expect(page).toHaveURL(origin + basepath + '/architecture-lab')
		await input.fill('Draft A survives native layout')
		inputA = await input.elementHandle()
		await rename(tab('Pluxel Architecture Lab'), 'Studio A')
		await openMenu(tab('Studio A'))
		await menu().getByRole('menuitem', { name: '在新标签打开副本', exact: true }).click()
		await expect(input).toHaveValue('Pluxel architecture in practice')
		await input.fill('Independent draft B')
		inputB = await input.elementHandle()
		await rename(tab('Studio A（副本）'), 'Studio B')
		await tab('Studio A').click()
		await expect(input).toHaveValue('Draft A survives native layout')
		await showApps()
		await entry('Architecture Lab').click()
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
				await newDocument('Architecture Lab')
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
		await menu().getByRole('button', { name: '分组颜色 4', exact: true }).click()
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
		'Border tool selection retains document URL; explicit activation reveals document',
		async () => {
			await openMenu(tab('Studio A'))
			await menu().getByRole('menuitem', { name: '移动标签到：左边栏', exact: true }).click()
			await tab('Studio A').click()
			const accepted = page.url()
			await page.getByRole('tab', { name: '插件目录', exact: true }).click()
			await expect(page).toHaveURL(accepted)
			await expect(page.getByRole('heading', { name: '报表工作流', exact: true })).toBeVisible()
			await retained()
			await showApps()
			await entry('Architecture Lab').click()
			await expect(reportInput('Studio A')).toHaveValue('Draft A survives native layout')
			await retained()
		},
	)
	await check('F6 content/tab focus and context keyboard return focus', async () => {
		await tab('Studio A').focus()
		await page.keyboard.press('F6')
		const input = reportInput('Studio A')
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
						?.children.some((node) => node.name === 'Studio A'),
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
			await expect(page.getByText(/native-identity-conflict:/)).toHaveCount(0)
		},
	)
	await check(
		'full TabSet close includes collapsed groups and retains pinned tabs elsewhere',
		async () => {
			if ((await pill.getAttribute('aria-expanded')) !== 'true') await pill.click()
			await tab('Studio B').click()
			const restoredInput = await reportInput('Studio B').elementHandle()
			assert.ok(restoredInput)
			if ((await pill.getAttribute('aria-expanded')) === 'true') await pill.click()
			await expect(pill).toHaveAttribute('aria-expanded', 'false')
			await page.getByRole('button', { name: '标签容器操作', exact: true }).last().click()
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
			await page.locator('.plx-activity [aria-label="插件管理"]').click()
			await expect(tab('插件')).toBeVisible()
			await expect
				.poll(async () =>
					nodes(await snapshot()).some(
						(node) => node.component === 'worksplit.document' && node.name === '插件',
					),
				)
				.toBe(true)
			const initialDocuments = nodes(await snapshot()).filter(
				(node) => node.component === 'worksplit.document',
			).length
			for (let index = 0; index < 12; index++) {
				await newDocument('首页')
				await expect
					.poll(
						async () =>
							nodes(await snapshot()).filter((node) => node.component === 'worksplit.document')
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
				(candidate) => candidate.descriptor.owner.exportName === 'PackageManagerPlugin',
			)
			assert.equal(publication?.placement.kind, 'route')
			assert.equal(publication.placement.path, '/packages')
			const title = publication.placement.title
			const before = await consoleRun('packageManagerSnapshot')
			await showApps()
			await entry(title).click()
			await expect(page).toHaveURL(origin + basepath + '/packages')
			const pane = page.getByRole('tabpanel', { name: title, exact: true })
			await expect(
				pane.getByRole('heading', { name: 'Managed plugin packages', exact: true }),
			).toBeVisible()
			const input = pane.getByRole('textbox', { name: 'Install package specs', exact: true })
			await expect(input).toBeEnabled()
			await expect(pane.getByText(/^pnpm /)).toBeVisible()
			await expect(pane.getByText('Managed root:', { exact: false })).toContainText(before.rootDir)
			await expect(pane.locator('tbody tr')).toHaveCount(before.packages.length)
			const packageInputA = await input.elementHandle()
			const draftA = '@pluxel/browser-draft-a@0.0.0'
			await input.fill(draftA)
			await showApps()
			await entry(title).click()
			await expect(tabs).toHaveCount(3)
			await expect(input).toHaveValue(draftA)
			const reused = await input.elementHandle()
			assert.ok(await packageInputA.evaluate((element, other) => element === other, reused))
			await openMenu(tab(title))
			await menu().getByRole('menuitem', { name: '在右侧打开副本', exact: true }).click()
			const copyTitle = `${title}（副本）`
			await expect(tab(copyTitle)).toBeVisible()
			const copyPane = page.getByRole('tabpanel', { name: copyTitle, exact: true })
			const copyInput = copyPane.getByRole('textbox', {
				name: 'Install package specs',
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
				heading: 'Managed plugin packages',
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
	if (values.lifecycle)
		await check(
			'real plugin stop withdraws epoch, destroys old MF roots and permits fresh activation',
			async () => {
				await showApps()
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
	await expect(page.getByText('HMR 已应用', { exact: true })).toBeVisible()
	receipt.hmr = await page.locator('.plx-workspace__update-status').innerText()
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
	if (stopped)
		await consoleRun('startStudio').catch((error) => {
			receipt.restoreFailure = String(error)
			process.exitCode = 1
		})
	await writeFile(resolve(artifacts, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
	await browser.close()
	console.log(`Receipt: ${resolve(artifacts, 'receipt.json')}`)
}
