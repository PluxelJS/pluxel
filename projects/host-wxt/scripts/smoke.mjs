import assert from 'node:assert/strict'
import {
	cp,
	mkdir,
	mkdtempDisposable,
	readFile,
	rename,
	symlink,
	writeFile,
} from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'
import { build, createServer } from 'wxt'

const root = resolve(import.meta.dirname, '..')
const input = 'https://example.org/guide?name=two%20words&utm_source=mail&tag=a&tag=b#install'
const clean = input.replace('&utm_source=mail', '')

async function edit(file, code) {
	await writeFile(file + '.next', code)
	await rename(file + '.next', file)
}

async function expectLink(page, expected) {
	try {
		await page.waitForFunction(
			(link) => document.querySelector('#result')?.value === link,
			expected,
		)
	} catch (cause) {
		throw new Error(
			`Expected ${expected}. Popup displays: ${await page.locator('body').innerText()}`,
			{ cause },
		)
	}
}

// Exercise both the release and source edits in isolation from running WXT instances.
const scratch = resolve(root, '../../.tmp')
await mkdir(scratch, { recursive: true })
await using fixture = await mkdtempDisposable(join(scratch, 'host-wxt-'))
for (const file of [
	'package.json',
	'assets',
	'modules',
	'entrypoints',
	'src',
	'tsconfig.json',
	'wxt.config.ts',
]) {
	await cp(join(root, file), join(fixture.path, file), { recursive: true })
}
await symlink(join(root, 'node_modules'), join(fixture.path, 'node_modules'), 'dir')

const { steps } = await build({ root: fixture.path })
const chunks = steps.flatMap((step) => step.chunks.filter((file) => file.type === 'chunk'))
assert.ok(
	chunks.length > 0 && chunks.every((chunk) => chunk.moduleIds.length > 0),
	'WXT reported bundled modules for every JS chunk',
)
for (const { fileName, moduleIds } of chunks) {
	const managementModules = moduleIds.filter((id) => {
		const path = id.replaceAll('\\', '/')
		return (
			/(?:^|\/)(?:packages|@pluxel)\/workbench\//.test(path) ||
			/(?:^|\/)(?:packages|@pluxel)\/services\/(?:src\/|dist\/)?(?:management|workbench)[./-]/.test(
				path,
			)
		)
	})
	assert.deepEqual(managementModules, [], `${fileName}: ${managementModules.join(', ')}`)
}

const context = await chromium.launchPersistentContext('', {
	channel: 'chromium',
	headless: true,
	ignoreDefaultArgs: ['--disable-extensions'],
	args: ['--enable-unsafe-extension-debugging'],
})
try {
	context.setDefaultTimeout(30_000)
	const page = context.pages()[0]
	page.on('pageerror', (error) => console.error(error))
	const cdp = await context.browser().newBrowserCDPSession()
	const release = join(fixture.path, '.output/chrome-mv3')
	const manifest = JSON.parse(await readFile(join(release, 'manifest.json'), 'utf8'))
	assert.equal(manifest.manifest_version, 3)
	assert.deepEqual(manifest.permissions.sort(), [
		'activeTab',
		'contextMenus',
		'scripting',
		'storage',
	])
	assert.equal(manifest.host_permissions, undefined)
	assert.equal(manifest.content_scripts, undefined)
	assert.equal(manifest.content_security_policy, undefined)
	assert.equal(manifest.background.service_worker, 'background.js')
	assert.equal(manifest.options_ui.open_in_tab, true)

	const { id } = await cdp.send('Extensions.loadUnpacked', { path: release })
	await context.setOffline(true)
	await page.goto(`chrome-extension://${id}/${manifest.action.default_popup}`)
	const source = page.getByLabel('原始链接')
	await source.fill(input)
	await expectLink(page, clean)
	const other = await context.newPage()
	await other.goto(page.url() + '#' + new URLSearchParams({ link: input }))
	await expectLink(other, clean)
	const [settings] = await Promise.all([
		context.waitForEvent('page'),
		page.getByRole('button', { name: '规则设置' }).click(),
	])
	await settings.waitForURL(`chrome-extension://${id}/${manifest.options_ui.page}`)
	const trackingForm = settings.getByRole('region', { name: '移除 UTM 追踪参数' })
	const extra = trackingForm.getByRole('textbox')
	const save = trackingForm.getByRole('button', { name: '保存配置' })
	await extra.fill('tag ref')
	await save.click()
	await trackingForm.getByRole('status').filter({ hasText: '请用逗号分隔' }).waitFor()
	await expectLink(page, clean)
	const secondEditor = await context.newPage()
	await secondEditor.goto(settings.url())
	const secondForm = secondEditor.getByRole('region', { name: '移除 UTM 追踪参数' })
	await secondForm.getByRole('textbox').fill('ref')
	await extra.fill('tag')
	await save.click()
	await expectLink(page, clean.replace('&tag=a&tag=b', ''))
	await expectLink(other, clean.replace('&tag=a&tag=b', ''))
	await secondForm.getByRole('button', { name: '载入最新配置' }).waitFor()
	await secondForm.getByRole('button', { name: '保存配置' }).click()
	await secondForm
		.getByRole('status')
		.filter({ hasText: /refresh|重新读取|版本已变化/ })
		.waitFor()
	assert.equal(await secondForm.getByRole('textbox').inputValue(), 'ref')
	await expectLink(page, clean.replace('&tag=a&tag=b', ''))
	await secondForm.getByRole('button', { name: '载入最新配置' }).click()
	assert.equal(await secondForm.getByRole('textbox').inputValue(), 'tag')
	await secondEditor.close()
	await settings.reload()
	await settings.waitForFunction(() => document.querySelector('input[type=text]')?.value === 'tag')
	await trackingForm.getByRole('button', { name: '恢复插件默认配置' }).click()
	await expectLink(page, clean)
	await settings.getByRole('switch', { name: '移除 UTM 追踪参数', disabled: false }).press('Space')
	await expectLink(page, input)
	await expectLink(other, input)
	await other.close()
	await extra.fill('tag')
	await save.click()
	await trackingForm.getByRole('status').filter({ hasText: '启用时采用' }).waitFor()
	await expectLink(page, input)
	await settings.getByRole('switch', { name: '移除 UTM 追踪参数', disabled: false }).press('Space')
	await expectLink(page, clean.replace('&tag=a&tag=b', ''))
	await trackingForm.getByRole('button', { name: '恢复插件默认配置' }).click()
	await expectLink(page, clean)
	await settings.getByRole('switch', { name: '移除 UTM 追踪参数', disabled: false }).press('Space')
	await expectLink(page, input)
	await settings.getByRole('switch', { name: '移除页内锚点', disabled: false }).press('Space')
	await expectLink(page, input.split('#')[0])
	const routerLink = 'https://example.org/app#/inbox'
	await source.fill(routerLink)
	await expectLink(page, routerLink)
	const fragmentForm = settings.getByRole('region', { name: '移除页内锚点' })
	await fragmentForm
		.getByRole('switch', { name: '同时移除哈希路由', disabled: false })
		.press('Space')
	await fragmentForm.getByRole('button', { name: '保存配置' }).click()
	await expectLink(page, 'https://example.org/app')
	await fragmentForm.getByRole('button', { name: '恢复插件默认配置' }).click()
	await expectLink(page, routerLink)
	await page.reload()
	await source.fill(input)
	await expectLink(page, input.split('#')[0])
	await settings.getByRole('button', { name: '恢复默认启停' }).click()
	await expectLink(page, clean)
	await settings.evaluate(() => chrome.storage.local.set({ tracking: null }))
	await page.locator('#status').filter({ hasText: 'tracking' }).waitFor()
	await source.fill('https://example.org/other')
	assert.equal(await page.locator('#result').textContent(), '')
	await page.reload()
	await source.fill(input)
	await page.locator('#status').filter({ hasText: 'tracking' }).waitFor()
	await settings.getByRole('button', { name: '恢复默认启停' }).click()
	await expectLink(page, clean)
	await settings.close()

	// Trigger the native toolbar action on a web tab to grant activeTab for this origin.
	const website = await context.newPage()
	await website.route('https://example.org/**', (route) =>
		route.fulfill({
			contentType: 'text/html',
			body: '<link rel="canonical" href="/canonical?utm_source=canonical&amp;q=1">',
		}),
	)
	await website.goto(input)
	const { targetInfos } = await cdp.send('Target.getTargets', { filter: [{ type: 'tab' }] })
	const target = targetInfos.find((tab) => tab.url === website.url())
	assert.ok(target, 'web tab is available to the toolbar action')
	await cdp.send('Extensions.triggerAction', { id, targetId: target.targetId })
	// The browser owns the toolbar popup. Read it from a same-origin extension view.
	const toolbar = await page.waitForFunction(
		() => chrome.extension.getViews({ type: 'popup' })[0]?.document,
	)
	await page.waitForFunction(
		({ doc, expected }) => doc.querySelector('#result')?.value === expected,
		{ doc: toolbar, expected: clean },
	)
	await toolbar.evaluate((doc) => doc.querySelector('#canonical').click())
	await page.waitForFunction(
		(doc) => doc.querySelector('#result')?.value === 'https://example.org/canonical?q=1',
		toolbar,
	)
	await toolbar.dispose()
	await website.close()
	// Chromium rejects an update if the service worker did not install this native menu.
	await page.evaluate(() => chrome.contextMenus.update('clean-link', { enabled: true }))
	await context.setOffline(false)

	// An unrelated generation stamps its own identity onto each result in this fixture.
	const fragment = join(fixture.path, 'src/fragment.ts')
	const fragmentCode = await readFile(fragment, 'utf8')
	await writeFile(
		fragment,
		fragmentCode
			.replace(
				'private clean(',
				'private readonly generation = crypto.randomUUID()\n\tprivate clean(',
			)
			.replace("link.split('#', 1)[0]!", "link.split('#', 1)[0]! + '#' + this.generation"),
	)
	// Separate consecutive synthetic saves into distinct watcher events.
	const dev = await createServer({
		root: fixture.path,
		webExt: { disabled: true },
		watchOptions: { awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 20 } },
	})
	try {
		await dev.start()
		const { id: devId } = await cdp.send('Extensions.loadUnpacked', {
			path: join(fixture.path, '.output/chrome-mv3-dev'),
		})
		await page.goto(`chrome-extension://${devId}/popup.html`)
		await source.fill(input)
		await expectLink(page, clean)
		const opened = await page.evaluate(() => performance.timeOrigin)
		const devSettings = await context.newPage()
		await devSettings.goto(`chrome-extension://${devId}/options.html`)
		await devSettings.getByRole('switch', { name: '移除页内锚点', disabled: false }).press('Space')
		const settingsOpened = await devSettings.evaluate(() => performance.timeOrigin)
		await page.waitForFunction(() => /#[a-f\d-]{36}$/.test(document.querySelector('#result').value))
		const stamped = await page.locator('#result').textContent()
		const tracking = join(fixture.path, 'src/tracking.ts')
		const original = await readFile(tracking, 'utf8')
		const edited = original
			.replace('/^utm_/i', '/^(utm_|tag$)/i')
			.replace("title: '额外移除的参数'", "title: '额外追踪参数'")
		assert.notEqual(edited, original)
		await edit(tracking, edited)
		// Unchanged draft + unchanged sibling instance + new plugin behavior in the mounted page.
		await expectLink(page, stamped.replace('&tag=a&tag=b', ''))
		await devSettings.getByText('额外追踪参数', { exact: true }).waitFor()

		await edit(tracking, edited + "\nthrow new Error('Rejected smoke edit')\n")
		await page.locator('#status').filter({ hasText: '插件更新求值失败' }).waitFor()
		await expectLink(page, stamped.replace('&tag=a&tag=b', ''))
		await edit(tracking, original)
		await expectLink(page, stamped)
		await devSettings.getByText('额外移除的参数', { exact: true }).waitFor()
		assert.equal(await page.evaluate(() => performance.timeOrigin), opened)
		assert.equal(await devSettings.evaluate(() => performance.timeOrigin), settingsOpened)
	} finally {
		await dev.stop()
	}
} finally {
	await context.close()
}
console.log('MV3 offline build, persisted plugin choices, same-Host HMR and recovery passed.')
