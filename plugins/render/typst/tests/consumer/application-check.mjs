import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chooseWorkspaceFile } from './workspace-ui.mjs'

/** User-facing form edits, source preservation, native preview and independent folder storage. */
export async function checkApplicationForm(page, output) {
	const button = (name) => page.getByRole('button', { name, exact: true })
	const storageKey = 'typst-source-application-v1'
	const current = async (revision) => {
		await page.waitForFunction(
			(expected) => {
				const download = [...document.querySelectorAll('.preview-pane button')].find(
					(item) => item.getClientRects().length > 0 && item.textContent === '下载 PDF',
				)
				const state = [...document.querySelectorAll('.preview-pane [data-testid="revision"]')].find(
					(element) => element.getClientRects().length > 0,
				)?.textContent
				return (
					download &&
					!download.disabled &&
					state?.includes('预览已同步') &&
					(expected === undefined || state.includes(`源码 ${expected}`))
				)
			},
			revision,
			{ timeout: 45000 },
		)
		assert.deepEqual(await page.locator('.source-failure').allTextContents(), [])
	}
	const snapshot = async () => {
		await button('保存项目').click()
		return page.evaluate((key) => JSON.parse(localStorage.getItem(key)), storageKey)
	}
	const next = (predicate) =>
		page.waitForResponse(
			(response) => {
				if (new URL(response.url()).pathname !== '/compile' || !response.ok()) return false
				const files = response.request().postDataJSON()?.files
				return (
					files?.['data/application.json'] && predicate(JSON.parse(files['data/application.json']))
				)
			},
			{ timeout: 45000 },
		)
	const compiled = async (response) => {
		const accepted = await response
		const result = await accepted.json()
		await current(result.clientRevision)
		assert.ok(result.preview.data.length > 0)
		return result
	}
	await page.setViewportSize({ width: 1440, height: 1000 })
	await page.emulateMedia({ colorScheme: 'light' })
	await page.evaluate(() => document.documentElement.style.removeProperty('color-scheme'))
	await button('保存项目').click()
	const report = await page.evaluate(() => localStorage.getItem('typst-source-project-v2'))
	const url = page.url()
	const seedResponse = await page.request.get(new URL('/workspace', url).href)
	assert.equal(seedResponse.status(), 200)
	const workspace = await seedResponse.json()
	assert.deepEqual(Object.keys(workspace).sort(), ['application-form', 'report'])
	const seed = workspace['application-form'].files
	await chooseWorkspaceFile(page, 'data/application.json', 'application-form')
	assert.equal(page.url(), url, 'Choosing a workspace folder must not navigate the URL')
	await page.getByRole('region', { name: '申请填报', exact: true }).waitFor()
	await current()
	assert.deepEqual(
		await snapshot(),
		seed,
		'Opening and saving a form must preserve all source bytes',
	)

	const name = page.getByRole('textbox', { name: '姓名', exact: true })
	await name.focus()
	await name.press('Tab')
	assert.deepEqual(await snapshot(), seed)
	await name.fill('张同学')
	const named = next((data) => data.name === '张同学')
	const afterName = await snapshot() // One click must first commit the focused field, then save it.
	await compiled(named)
	assert.equal(JSON.parse(afterName['data/application.json']).name, '张同学')
	await chooseWorkspaceFile(page, 'sections/analysis.typ', 'report')
	await current()
	assert.equal(page.url(), url)
	assert.equal(await page.evaluate(() => localStorage.getItem('typst-source-project-v2')), report)
	await chooseWorkspaceFile(page, 'data/application.json', 'application-form')
	await current()
	assert.equal(await name.inputValue(), '张同学')
	const undo = next((data) => data.name === JSON.parse(seed['data/application.json']).name)
	await button('撤销填报').click()
	await compiled(undo)
	assert.deepEqual(
		await snapshot(),
		seed,
		'One undo must restore the entire field and all original bytes',
	)
	const redo = next((data) => data.name === '张同学')
	await button('重做填报').click()
	await compiled(redo)
	assert.deepEqual(await snapshot(), afterName)

	const student = page.getByRole('textbox', { name: '学号', exact: true })
	await student.fill('001023')
	const numbered = next((data) => data.studentId === '001023')
	await student.press('Enter')
	await compiled(numbered)
	const reason = page.getByRole('textbox', { name: '申请理由', exact: true })
	const reasonText = '申请参加科研项目。\n第二行保留 #[] *内容* 和 "引号"，按普通文字排版。\n'
	await reason.fill(reasonText.slice(0, -1))
	await reason.press('End')
	await reason.press('Enter')
	assert.equal(
		await reason.inputValue(),
		reasonText,
		'Enter in a multiline field must insert a newline',
	)
	const reasoned = next((data) => data.reason === reasonText)
	await reason.press('Tab')
	await compiled(reasoned)
	const renewed = next((data) => data.applicationType === 'renew')
	await page.getByRole('radio', { name: '续期', exact: true }).check()
	await compiled(renewed)
	assert.equal(await page.getByRole('radio', { checked: true }).count(), 1)
	const opinion = page.getByRole('textbox', { name: '审批意见', exact: true })
	await opinion.fill('同意申请。\n按计划开展。')
	const reviewed = next((data) => data.opinion === '同意申请。\n按计划开展。')
	await opinion.press('Tab')
	await compiled(reviewed)
	const signature = page.getByRole('textbox', { name: '申请人签字', exact: true })
	await signature.fill('张同学')
	const signed = next((data) => data.signature === '张同学')
	await signature.press('Enter')
	await compiled(signed)
	const date = page.getByLabel('日期', { exact: true })
	await date.fill('2026-11-02')
	const dated = next((data) => data.date === '2026-11-02')
	await date.press('Enter')
	await compiled(dated)
	const filled = await snapshot()
	assert.deepEqual(JSON.parse(filled['data/application.json']), {
		name: '张同学',
		studentId: '001023',
		applicationType: 'renew',
		reason: reasonText,
		opinion: '同意申请。\n按计划开展。',
		signature: '张同学',
		date: '2026-11-02',
	})
	for (const [file, source] of Object.entries(seed))
		if (file !== 'data/application.json') assert.deepEqual(filled[file], source)
	await name.fill('应该放弃的输入')
	await name.press('Escape')
	assert.equal(await name.inputValue(), '张同学')
	assert.deepEqual(await snapshot(), filled)

	for (const scheme of ['light', 'dark']) {
		await page.emulateMedia({ colorScheme: scheme })
		await page.locator('.application-form').evaluate((element) => {
			element.scrollTop = 0
		})
		assert.equal(
			await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
			true,
		)
		await page.screenshot({ path: resolve(output, `${scheme}-desktop-application.png`) })
	}
	await page.emulateMedia({ colorScheme: 'light' })
	await page.setViewportSize({ width: 1440, height: 1000 })
	const longReason = Array.from(
		{ length: 70 },
		(_, index) =>
			`第${index + 1}段：申请内容应完整保留，行高不足时继续到下一页，不覆盖审批意见和签字。`,
	).join('\n\n')
	await reason.fill(longReason)
	const extended = next((data) => data.reason === longReason)
	await reason.press('Tab')
	await compiled(extended)
	assert.ok(
		(await page.locator('.preview-pane:visible .typst-page').count()) > 1,
		'Long content must produce additional native pages',
	)
	const longFiles = await snapshot()
	assert.equal(JSON.parse(longFiles['data/application.json']).reason, longReason)
	for (const [file, source] of Object.entries(filled))
		if (file !== 'data/application.json') assert.deepEqual(longFiles[file], source)
	const exported = page.waitForEvent('download')
	await button('下载 PDF').click()
	const pdf = await exported
	assert.equal(pdf.suggestedFilename(), 'application.pdf')
	const pdfPath = resolve(output, 'application.pdf')
	await pdf.saveAs(pdfPath)
	const pdfBytes = await readFile(pdfPath)
	assert.equal(pdfBytes.subarray(0, 5).toString(), '%PDF-')
	const reopened = next((data) => data.reason === longReason)
	await page.reload()
	await chooseWorkspaceFile(page, 'data/application.json', 'application-form')
	await page.getByRole('region', { name: '申请填报', exact: true }).waitFor()
	await compiled(reopened)
	assert.equal(await reason.inputValue(), longReason)
	assert.deepEqual(await snapshot(), longFiles)
	await chooseWorkspaceFile(page, 'main.typ', 'application-form')
	assert.equal(await page.getByRole('textbox', { name: '文件源码' }).isEditable(), false)
	await chooseWorkspaceFile(page, 'data/application.json', 'application-form')
	const reset = next((data) => data.reason === JSON.parse(seed['data/application.json']).reason)
	await button('重置示例').click()
	await compiled(reset)
	assert.deepEqual(await snapshot(), seed)
	await chooseWorkspaceFile(page, 'sections/analysis.typ', 'report')
	await page.locator('.workspace-panel:visible .tiptap').waitFor()
	await current()
	assert.equal(page.url(), url)
	assert.equal(await page.evaluate(() => localStorage.getItem('typst-source-project-v2')), report)
	return [
		'审批表文件夹：空表不改源码，字段失焦或 Enter 确认，单选立即更新，多行 Enter 保留换行，Escape 放弃输入',
		'填报写入真实 JSON，学号前导零与特殊字符保留，模板与其他文件不变；一次撤销重做恢复整笔字段及源码字节',
		'长内容由原生模板自动续页，完整数据保存重开且导出真实 PDF；桌面明暗主题可用，两个文件夹通过树切换且 URL 不变，数据与撤销历史隔离并保留',
	]
}
