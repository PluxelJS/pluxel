import assert from 'node:assert/strict'
import { resolve } from 'node:path'

export async function checkDefaultParameters(page, output) {
	await page.evaluate(async () => {
		const fixture = await import('/parameter-fixture.tsx')
		window.typstParameterFixture = await fixture.mountParameterFixture()
	})
	const host = page.locator('#typst-parameter-fixture')
	const dialog = page.getByRole('dialog', { name: '参数示例设置', exact: true })
	const files = () => page.evaluate(() => window.typstParameterFixture.files())
	const undo = async (before) => {
		assert.equal(await page.evaluate(() => window.typstParameterFixture.undo().ok), true)
		assert.deepEqual(await files(), before)
	}
	const open = async () => {
		await host.getByRole('button', { name: '编辑参数', exact: true }).click()
		await dialog.waitFor()
	}
	const apply = async () => {
		await dialog.getByRole('button', { name: '应用参数', exact: true }).click()
		await dialog.waitFor({ state: 'hidden' })
	}
	try {
		await host.locator('.typst-component').waitFor()
		const baseline = await files()
		await open()
		for (const scheme of ['light', 'dark']) {
			await page.emulateMedia({ colorScheme: scheme })
			for (const [layout, viewport] of [
				['desktop', { width: 1440, height: 1000 }],
				['mobile', { width: 390, height: 844 }],
			]) {
				await page.setViewportSize(viewport)
				await page.waitForFunction(() => {
					const panel = document
						.querySelector('[aria-label="参数示例设置"]')
						?.getBoundingClientRect()
					return (
						panel &&
						panel.left >= 0 &&
						panel.right <= innerWidth &&
						panel.top >= 0 &&
						panel.bottom <= innerHeight
					)
				})
				await page.screenshot({
					path: resolve(output, `${scheme}-${layout}-default-parameters.png`),
				})
			}
		}
		await page.emulateMedia({ colorScheme: 'light' })
		await page.setViewportSize({ width: 1440, height: 1000 })
		await dialog.getByRole('spinbutton', { name: '数量', exact: true }).fill('')
		await apply()
		let saved = await files()
		assert.doesNotMatch(saved['main.typ'], /count:/)
		assert.match(saved['main.typ'], /loud: true, title: "原始标题"/)
		assert.equal(saved['component.typ'], baseline['component.typ'])
		await undo(baseline)

		await open()
		await dialog.getByRole('spinbutton', { name: '数量', exact: true }).fill('0')
		await apply()
		saved = await files()
		assert.match(saved['main.typ'], /count: 0/)
		await undo(baseline)

		await open()
		await dialog.getByRole('combobox', { name: '显示标记', exact: true }).selectOption('')
		await dialog.getByRole('button', { name: '恢复标题默认', exact: true }).click()
		await apply()
		saved = await files()
		assert.doesNotMatch(saved['main.typ'], /loud:|title:/)
		assert.match(saved['main.typ'], /count: 7/)
		await undo(baseline)

		await open()
		await dialog.getByRole('textbox', { name: '标题', exact: true }).fill('')
		await apply()
		saved = await files()
		assert.match(saved['main.typ'], /title: ""/)
		await undo(baseline)
		return [
			'默认参数表单：空数字恢复默认、0保留、布尔与字符串可恢复默认，空字符串独立保留，每笔撤销恢复源码字节',
		]
	} finally {
		await page.evaluate(() => {
			window.typstParameterFixture.dispose()
			delete window.typstParameterFixture
		})
	}
}
