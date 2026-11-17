import assert from 'node:assert/strict'
import { resolve } from 'node:path'

export async function checkFieldEditing(page, output) {
	const mount = async (writablePaths) => {
		await page.evaluate(async (paths) => {
			const fixture = await import('/parameter-fixture.tsx')
			window.typstFieldFixture = await fixture.mountFieldFixture(paths)
		}, writablePaths)
		await page.locator('#typst-parameter-fixture .typst-component').waitFor()
	}
	const dispose = () =>
		page.evaluate(() => {
			window.typstFieldFixture.dispose()
			delete window.typstFieldFixture
		})
	const view = (props) => page.evaluate((next) => window.typstFieldFixture.view(next), props)
	const files = () => page.evaluate(() => window.typstFieldFixture.files())
	const host = page.locator('#typst-parameter-fixture')
	const fields = host.locator('.typst-source-field')
	await mount()
	try {
		const baseline = await files()
		assert.equal(await fields.count(), 4)
		assert.equal(await fields.getByRole('button').count(), 0, 'Unlisted fields only display data')
		await host.getByRole('button', { name: '数据：data.json', exact: true }).click()
		const data = page.getByRole('dialog', { name: '共享数据（只读）', exact: true })
		const json = data.getByRole('textbox', { name: 'JSON data.json', exact: true })
		await json.waitFor()
		assert.equal(await json.evaluate((element) => element.readOnly), true)
		assert.equal(await data.getByRole('button', { name: '保存 JSON', exact: true }).count(), 0)
		await data.getByRole('button', { name: '关闭', exact: true }).click()
		await data.waitFor({ state: 'hidden' })
		assert.deepEqual(await files(), baseline)

		await view({ editableFields: [{ file: 'data.json', path: ['company'] }] })
		const company = fields.getByRole('button', { name: '只读公司', exact: true })
		await company.waitFor()
		assert.equal(await fields.getByRole('button').count(), 1)
		await page.screenshot({ path: resolve(output, 'light-desktop-field-access.png') })
		await company.click()
		const field = page.getByRole('dialog', { name: '字段 · company', exact: true })
		await field.getByRole('textbox', { name: '字段值 company', exact: true }).fill('可编辑公司')
		await field.getByRole('button', { name: '保存 JSON', exact: true }).click()
		await field.waitFor({ state: 'hidden' })
		const saved = await files()
		assert.deepEqual(JSON.parse(saved['data.json']), {
			company: '可编辑公司',
			period: '2026 Q3',
			rows: [{ amount: 12 }],
		})
		for (const [file, contents] of Object.entries(baseline))
			if (file !== 'data.json') assert.deepEqual(saved[file], contents)
		assert.equal(await page.evaluate(() => window.typstFieldFixture.undo().ok), true)
		assert.deepEqual(await files(), baseline)

		await view({ editableFields: [{ file: 'data.json', path: ['rows'] }] })
		await fields.getByRole('button', { name: '12', exact: true }).waitFor()
		assert.equal(await fields.getByRole('button').count(), 1, 'A subtree excludes derived length')
		await view({ editableFields: [{ file: 'data.json', path: [] }] })
		await company.waitFor()
		assert.equal(await fields.getByRole('button').count(), 3)
		await host.getByRole('button', { name: '数据：data.json', exact: true }).click()
		const writable = page.getByRole('dialog', { name: '共享数据', exact: true })
		await writable.waitFor()
		assert.equal(
			await writable
				.getByRole('textbox', { name: 'JSON data.json', exact: true })
				.evaluate((element) => element.readOnly),
			false,
		)
		await writable.getByRole('button', { name: '取消', exact: true }).click()
		await writable.waitFor({ state: 'hidden' })
		await view({ editable: false, editableFields: [{ file: 'data.json', path: [] }] })
		await company.waitFor({ state: 'hidden' })
		assert.equal(await fields.getByRole('button').count(), 0)
		await page.emulateMedia({ colorScheme: 'dark' })
		await page.setViewportSize({ width: 390, height: 844 })
		await host.getByRole('button', { name: '数据：data.json', exact: true }).click()
		await data.waitFor()
		await page.screenshot({ path: resolve(output, 'dark-mobile-field-access.png') })
		await data.getByRole('button', { name: '关闭', exact: true }).click()
		assert.deepEqual(await files(), baseline)
	} finally {
		await dispose()
		await page.emulateMedia({ colorScheme: 'light' })
		await page.setViewportSize({ width: 1440, height: 1000 })
	}
	await mount([])
	try {
		await view({ editableFields: [{ file: 'data.json', path: [] }] })
		await host.getByRole('button', { name: '数据：data.json', exact: true }).click()
		const data = page.getByRole('dialog', { name: '共享数据（只读）', exact: true })
		await data.waitFor()
		assert.equal(
			await data
				.getByRole('textbox', { name: 'JSON data.json', exact: true })
				.evaluate((element) => element.readOnly),
			true,
		)
		assert.equal(
			await fields.getByRole('button').count(),
			0,
			'A field declaration cannot open a read-only file',
		)
	} finally {
		await dispose()
	}
	return [
		'字段默认只展示，声明后自动使用普通控件；只读模板可编辑开放的 JSON 字段，其他数据与源码不变且撤销恢复字节',
		'字段子树与整份 JSON 显式开放，派生数组长度保持只读；文件只读及整个视图只读优先，未开放的共享数据仅可查看',
	]
}
