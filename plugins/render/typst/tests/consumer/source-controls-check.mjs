import assert from 'node:assert/strict'
import { chooseWorkspaceFile } from './workspace-ui.mjs'

/** Verify native popup controls without replacing the page's editor or project. */
export async function checkSourceControls(page, files) {
	const analysis = 'sections/analysis.typ'
	const company = String(JSON.parse(files['data/sales.json']).company)
	const button = (name) => page.getByRole('button', { name, exact: true })
	const fieldTrigger = page
		.locator('.workspace-panel:visible .typst-source-field')
		.getByRole('button', { name: company, exact: true })
		.first()
	const componentTrigger = page
		.locator('.workspace-panel:visible .typst-component')
		.first()
		.getByRole('button', { name: '编辑参数', exact: true })
	const importTrigger = page
		.locator('.workspace-panel:visible .typst-import')
		.nth(1)
		.getByRole('button', { name: '导入设置', exact: true })
	const snapshot = async () => {
		await button('保存项目').click()
		return page.evaluate(() => JSON.parse(localStorage.getItem('typst-source-project-v2')))
	}
	const returnedFocus = async (trigger) => {
		await page.waitForFunction(
			(element) => {
				const active = element.ownerDocument.activeElement
				return active === element || active?.matches('.tiptap[contenteditable="true"]')
			},
			await trigger.elementHandle(),
		)
	}
	const onlyDialog = async (dialog) => {
		await dialog.waitFor()
		assert.equal(await page.getByRole('dialog').count(), 1, 'Only one source form may stay open')
	}
	const tabOutside = async (dialog) => {
		for (let step = 0; step < 12; step++) {
			await page.keyboard.press('Tab')
			if (!(await dialog.isVisible())) return
			if (!(await dialog.evaluate((element) => element.contains(document.activeElement)))) return
		}
		assert.fail('Tab must be able to leave a source form')
	}
	const compositionGuard = async (dialog, input, draft) => {
		await input.focus()
		// Synthetic composition events exercise the guard, rather than an operating-system IME.
		await input.dispatchEvent('compositionstart', { data: '中' })
		try {
			await input.press('Enter')
			assert.equal(await dialog.isVisible(), true, 'IME confirmation Enter must not submit a form')
			await input.press('Control+Enter')
			await onlyDialog(dialog)
			assert.equal(
				await input.inputValue(),
				draft,
				'Composition confirmation must retain the draft',
			)
		} finally {
			if (await input.count()) await input.dispatchEvent('compositionend', { data: '中' })
		}
	}
	const canceled = async (dialog, trigger, close) => {
		await close()
		await dialog.waitFor({ state: 'hidden' })
		await returnedFocus(trigger)
		assert.deepEqual(await snapshot(), files, 'Closing an unapplied form must preserve all bytes')
	}
	const compiled = async (pending) => {
		const response = await pending
		const value = await response.json()
		assert.equal(response.ok(), true, `Native /compile failed: ${JSON.stringify(value)}`)
		assert.equal(value.preview?.format, 'vector')
		assert.ok(value.preview.data.length > 0)
		await page.waitForFunction(
			() =>
				[...document.querySelectorAll('.preview-pane button')].some(
					(element) =>
						element.getClientRects().length > 0 &&
						element.textContent === '下载 PDF' &&
						!element.disabled,
				),
			undefined,
			{ timeout: 45000 },
		)
		assert.deepEqual(await page.locator('.source-failure').allTextContents(), [])
		return response.request().postDataJSON().files
	}
	const nextCompile = (accept) =>
		page.waitForResponse(
			(response) => {
				if (new URL(response.url()).pathname !== '/compile') return false
				try {
					return accept(response.request().postDataJSON().files)
				} catch {
					return false
				}
			},
			{ timeout: 45000 },
		)

	await chooseWorkspaceFile(page, analysis)
	await button('结构化编辑').click()
	assert.deepEqual(await snapshot(), files)

	await componentTrigger.click()
	const clean = page.getByRole('dialog', { name: '指标卡设置', exact: true })
	await onlyDialog(clean)
	await tabOutside(clean)
	await clean.waitFor({ state: 'hidden' })
	assert.deepEqual(await snapshot(), files, 'Tabbing out of a clean form must not write source')

	await fieldTrigger.click()
	const field = page.getByRole('dialog', { name: '字段 · company', exact: true })
	const fieldInput = field.getByRole('textbox', { name: '字段值 company', exact: true })
	const fieldDraft = '未应用的字段草稿'
	await fieldInput.fill(fieldDraft)
	await fieldTrigger.click()
	await onlyDialog(field)
	assert.equal(await fieldInput.inputValue(), fieldDraft, 'Reopening a field must retain its draft')
	await compositionGuard(field, fieldInput, fieldDraft)
	await tabOutside(field)
	await onlyDialog(field)
	assert.equal(await fieldInput.inputValue(), fieldDraft)
	await componentTrigger.click()
	await onlyDialog(field)
	assert.equal(
		await fieldInput.inputValue(),
		fieldDraft,
		'Another control must not replace a draft',
	)
	await canceled(field, fieldTrigger, () => fieldInput.press('Escape'))

	await componentTrigger.click()
	const component = page.getByRole('dialog', { name: '指标卡设置', exact: true })
	const title = component.getByRole('textbox', { name: '指标卡标题', exact: true })
	const componentDraft = '未应用的组件草稿'
	await title.fill(componentDraft)
	await componentTrigger.click()
	await onlyDialog(component)
	assert.equal(
		await title.inputValue(),
		componentDraft,
		'Reopening a component must retain its draft',
	)
	await compositionGuard(component, title, componentDraft)
	await button('插入').click()
	await onlyDialog(component)
	assert.equal(
		await title.inputValue(),
		componentDraft,
		'The toolbar must retain the pending draft',
	)
	await importTrigger.click()
	await onlyDialog(component)
	assert.equal(await title.inputValue(), componentDraft)
	await canceled(component, componentTrigger, () =>
		component.getByRole('button', { name: '取消', exact: true }).click(),
	)

	await importTrigger.click()
	const imported = page.getByRole('dialog', { name: '模块导入', exact: true })
	const items = imported.getByRole('textbox', { name: '导入成员', exact: true })
	const importDraft = 'revenue-chart, metrics'
	await items.fill(importDraft)
	await importTrigger.click()
	await onlyDialog(imported)
	assert.equal(await items.inputValue(), importDraft, 'Reopening an import must retain its draft')
	await compositionGuard(imported, items, importDraft)
	await fieldTrigger.click()
	await onlyDialog(imported)
	assert.equal(await items.inputValue(), importDraft)
	await canceled(imported, importTrigger, () =>
		imported.getByRole('button', { name: '关闭模块导入', exact: true }).click(),
	)

	await button('插入').click()
	await page.getByRole('option', { name: '导入模块…', exact: true }).click()
	const inserting = page.getByRole('dialog', { name: '导入模块', exact: true })
	const path = inserting.getByRole('combobox', { name: '模块路径', exact: true })
	await path.fill('../components/blocks.typ')
	await compositionGuard(inserting, path, '../components/blocks.typ')
	const selection = await page
		.locator('.workspace-panel:visible .tiptap')
		.evaluate((element) => element.editor.state.selection.toJSON())
	await componentTrigger.click()
	await onlyDialog(inserting)
	assert.equal(await path.inputValue(), '../components/blocks.typ')
	assert.deepEqual(
		await page
			.locator('.workspace-panel:visible .tiptap')
			.evaluate((element) => element.editor.state.selection.toJSON()),
		selection,
		'A refused popup switch must preserve the captured insertion selection',
	)
	await inserting.getByRole('button', { name: '取消', exact: true }).click()
	await inserting.waitFor({ state: 'hidden' })
	assert.deepEqual(await snapshot(), files, 'Canceling the file form must preserve all bytes')

	await componentTrigger.click()
	const originalTitle = await title.inputValue()
	const appliedTitle = '焦点应用核验'
	await title.fill(appliedTitle)
	const applied = nextCompile((candidate) =>
		candidate[analysis]?.includes(`title: "${appliedTitle}"`),
	)
	await component.getByRole('button', { name: '应用参数', exact: true }).click()
	await component.waitFor({ state: 'hidden' })
	await returnedFocus(componentTrigger)
	const appliedFiles = await compiled(applied)
	assert.deepEqual(await snapshot(), appliedFiles)
	assert.deepEqual(appliedFiles, {
		...files,
		[analysis]: files[analysis].replace(`title: "${originalTitle}"`, `title: "${appliedTitle}"`),
	})
	const undone = nextCompile((candidate) => candidate[analysis] === files[analysis])
	await button('撤销').click()
	await compiled(undone)
	assert.deepEqual(await snapshot(), files, 'Undoing an explicit apply must restore all bytes')

	const paragraph = page
		.locator('.workspace-panel:visible .tiptap p')
		.filter({ hasText: '本季度营收增长' })
		.first()
	await paragraph.click({ position: { x: 5, y: 10 } })
	await page.keyboard.press('End')
	const typed = nextCompile((candidate) => candidate[analysis]?.includes('/include'))
	await page.keyboard.insertText(' /include')
	const slashFiles = await compiled(typed)
	await page
		.getByRole('listbox', { name: '插入内容', exact: true })
		.getByRole('option', { name: '插入章节…', exact: true })
		.click()
	const chapter = page.getByRole('dialog', { name: '插入章节', exact: true })
	const chapterPath = chapter.getByRole('combobox', { name: '章节路径', exact: true })
	await chapterPath.fill('appe')
	const included = nextCompile((candidate) =>
		candidate[analysis]?.includes('#include "appendix.typ"'),
	)
	await chapterPath.press('Enter')
	await chapter.waitFor({ state: 'hidden' })
	const includedFiles = await compiled(included)
	assert.equal(includedFiles[analysis].split('#include "appendix.typ"').length, 2)
	assert.equal(includedFiles[analysis].includes('/include'), false)
	for (const [file, source] of Object.entries(files))
		if (file !== analysis) assert.deepEqual(includedFiles[file], source)
	const undoInclude = nextCompile((candidate) => candidate[analysis] === slashFiles[analysis])
	await button('撤销').click()
	await compiled(undoInclude)
	assert.deepEqual(await snapshot(), slashFiles)
	const undoSlash = nextCompile((candidate) => candidate[analysis] === files[analysis])
	await button('撤销').click()
	await compiled(undoSlash)
	assert.deepEqual(await snapshot(), files)

	return [
		'未应用字段、组件与导入重复点击入口保留草稿，其他入口不会叠开表单',
		'干净表单 Tab 离开即关闭，草稿保留；应用、取消、关闭按钮与 Escape 后焦点回入口或编辑器',
		'派发 composition 事件验证 Enter 和 Ctrl+Enter 保护层，取消保留全部源码字节；未声称真实系统输入法覆盖',
		'斜杠菜单的章节候选一次 Enter 直接插入，分别撤销章节和输入文字后项目字节恢复',
	]
}
