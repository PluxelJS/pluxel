import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { assertWorkspaceFile, chooseWorkspaceFile, workspaceFile } from './workspace-ui.mjs'

/** Create, edit and compile actual project files through the visible workspace tree. */
export async function checkWorkspace(page, output, checkTheme) {
	const analysis = 'sections/analysis.typ'
	const chapter = 'sections/workspace-notes.typ'
	const chapterText = '新建章节验收正文。'
	const marker = ' 工作区历史核验'
	const reportKey = 'typst-source-project-v2'
	const applicationKey = 'typst-source-application-v1'
	const button = (name) => page.getByRole('button', { name, exact: true })
	const tab = (name) => page.getByRole('tab', { name, exact: true })
	const pairedPreview = async (folder) => {
		const pane = page.locator(`.preview-pane[data-folder=${JSON.stringify(folder)}]:visible`)
		await pane.waitFor({ state: 'visible' })
		assert.equal(await tab(`${folder} · 预览`).getAttribute('aria-selected'), 'true')
		assert.equal(await pane.locator('.preview-heading span').textContent(), 'main.typ')
		const editorBox = await page.locator('.workspace-panel:visible').boundingBox()
		const previewBox = await pane.boundingBox()
		assert.ok(previewBox.x >= editorBox.x + editorBox.width - 1)
	}
	const snapshot = async () => {
		await button('保存项目').click()
		return page.evaluate((key) => JSON.parse(localStorage.getItem(key)), reportKey)
	}
	const nextCompile = (accept) =>
		page.waitForResponse(
			(response) => {
				if (new URL(response.url()).pathname !== '/compile') return false
				try {
					const request = response.request().postDataJSON()
					return accept(request.files)
				} catch {
					return false
				}
			},
			{ timeout: 45000 },
		)
	const current = async () => {
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
	}
	const compiled = async (pending) => {
		const response = await pending
		const value = await response.json()
		assert.equal(response.ok(), true, `Native /compile failed: ${JSON.stringify(value)}`)
		assert.equal(value.preview?.format, 'vector')
		assert.ok(value.preview.data.length > 0)
		await current()
		return { value, files: response.request().postDataJSON().files }
	}
	const editorEnd = async () => {
		await page
			.locator('.workspace-panel:visible .tiptap p')
			.last()
			.click({ position: { x: 5, y: 10 } })
		await page.keyboard.press('Control+End')
		await page.waitForFunction(() => {
			const element = [...document.querySelectorAll('.workspace-panel .tiptap')].find(
				(node) => node.getClientRects().length > 0,
			)
			const editor = element?.editor
			const dom = element?.ownerDocument.getSelection()
			return (
				editor &&
				document.activeElement === element &&
				editor.state.selection.empty &&
				editor.state.selection.from === editor.state.doc.content.size - 1 &&
				dom?.focusNode &&
				editor.view.posAtDOM(dom.focusNode, dom.focusOffset) === editor.state.selection.from
			)
		})
	}
	const newFile = async () => {
		await button('新建文件').click()
		const form = page.getByRole('form', { name: '新建文件', exact: true })
		await form.waitFor()
		const input = form.getByRole('textbox', { name: '新文件路径', exact: true })
		assert.equal(await input.inputValue(), 'sections/')
		return { form, input }
	}
	const previewText = async () => {
		const fragments = await page
			.locator('.preview-pane:visible .typst-page .tsel')
			.allTextContents()
		return fragments.join('')
	}
	const url = page.url()
	await page.setViewportSize({ width: 1440, height: 1000 })
	await page.emulateMedia({ colorScheme: 'light' })
	await page.evaluate(() => document.documentElement.style.removeProperty('color-scheme'))
	await chooseWorkspaceFile(page, analysis)
	await current()
	const baseline = await snapshot()
	assert.equal(Object.hasOwn(baseline, chapter), false)
	const application = await page.evaluate((key) => localStorage.getItem(key), applicationKey)
	// Start with native temporary tabs, independently of tabs opened by earlier checks.
	const freshPending = nextCompile((files) => files[analysis] === baseline[analysis])
	await page.reload()
	const fresh = await compiled(freshPending)
	assert.deepEqual(fresh.files, baseline)
	await assertWorkspaceFile(page, analysis)
	await pairedPreview('report')
	assert.equal(await tab('analysis.typ').locator('em').count(), 1)
	await chooseWorkspaceFile(page, 'sections/actions.typ')
	assert.equal(await tab('analysis.typ').count(), 0, 'An unedited temporary tab must be reused')
	assert.equal(await tab('actions.typ').locator('em').count(), 1)
	await chooseWorkspaceFile(page, analysis)
	assert.equal(await tab('actions.typ').count(), 0)

	await button('源码').click()
	const sourceInput = page.getByRole('textbox', { name: '文件源码', exact: true })
	const draft = `${baseline[analysis]}\n// 工作区标签草稿`
	await sourceInput.fill(draft)
	await tab('analysis.typ').locator('em').waitFor({ state: 'hidden' })
	await chooseWorkspaceFile(page, 'sections/actions.typ')
	assert.equal(await tab('analysis.typ').count(), 1, 'An unapplied draft must keep its native tab')
	assert.equal(
		await page
			.locator('.workspace-panel[data-folder="report"][data-file="sections/analysis.typ"] textarea')
			.inputValue(),
		draft,
	)
	await button('保存项目').click()
	assert.deepEqual(
		await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), reportKey),
		baseline,
	)
	assert.match(await page.locator('.source-status').textContent(), /尚未应用/)
	assert.equal(await button('下载 PDF').isDisabled(), true)
	await tab('analysis.typ').click()
	await assertWorkspaceFile(page, analysis)
	assert.equal(await sourceInput.inputValue(), draft)
	await button('重新载入当前源码').click()
	assert.equal(await sourceInput.inputValue(), baseline[analysis])
	await button('结构化编辑').click()
	await current()
	assert.deepEqual(await snapshot(), baseline)

	await chooseWorkspaceFile(page, 'sections/actions.typ')
	await button('源码').click()
	const actionsSource = await sourceInput.inputValue()
	await sourceInput.fill(`${actionsSource}\n// 保留标签以检查浮层归属`)
	await tab('actions.typ').locator('em').waitFor({ state: 'hidden' })
	await button('重新载入当前源码').click()
	await button('结构化编辑').click()
	await chooseWorkspaceFile(page, analysis)
	await page.locator('.workspace-panel:visible .typst-inline-source button').first().click()
	const inlineSource = page.getByRole('dialog', { name: 'Typst 源码', exact: true })
	const inlineDraft = '#upper("标签草稿验收")'
	await inlineSource.getByRole('textbox', { name: 'Typst 源码', exact: true }).fill(inlineDraft)
	await chooseWorkspaceFile(page, 'sections/actions.typ')
	assert.equal(await tab('analysis.typ').count(), 1)
	await inlineSource.waitFor({ state: 'hidden' })
	await page.locator('.workspace-panel:visible .tiptap p').first().click()
	assert.equal(
		await page
			.locator('.workspace-panel:visible .tiptap')
			.evaluate((element) => element.editor.isFocused),
		true,
	)
	await tab('analysis.typ').click()
	await assertWorkspaceFile(page, analysis)
	await inlineSource.waitFor({ state: 'visible' })
	assert.equal(
		await inlineSource.getByRole('textbox', { name: 'Typst 源码', exact: true }).inputValue(),
		inlineDraft,
	)
	await inlineSource.getByRole('textbox', { name: 'Typst 源码', exact: true }).press('Escape')
	await inlineSource.waitFor({ state: 'hidden' })
	assert.deepEqual(await snapshot(), baseline)

	for (const folder of ['report', 'application-form']) {
		const root = workspaceFile(page, '', folder)
		await root.click()
		assert.equal(await root.getAttribute('aria-expanded'), 'false')
		assert.equal(
			await page.locator('.workspace-panel:visible .active-file').textContent(),
			analysis,
		)
		await root.click()
		await assertWorkspaceFile(page, analysis)
	}
	const sections = workspaceFile(page, 'sections/')
	await sections.focus()
	await sections.press('ArrowLeft')
	assert.equal(await sections.getAttribute('aria-expanded'), 'false')
	await sections.press('ArrowRight')
	assert.equal(await sections.getAttribute('aria-expanded'), 'true')
	await sections.press('ArrowDown')
	assert.equal(
		await workspaceFile(page, 'sections/actions.typ').evaluate(
			(element) => element === document.activeElement,
		),
		true,
	)
	await page.keyboard.press('Enter')
	await assertWorkspaceFile(page, 'sections/actions.typ')
	await chooseWorkspaceFile(page, analysis)
	assert.equal(page.url(), url)
	assert.deepEqual(await snapshot(), baseline)

	const invalid = await newFile()
	for (const path of [analysis, '../escape.typ', 'sections/../escape.typ', 'sections/notes.md']) {
		await invalid.input.fill(path)
		await invalid.input.press('Enter')
		await invalid.form.getByRole('alert').waitFor()
		await assertWorkspaceFile(page, analysis)
		assert.deepEqual(await snapshot(), baseline, `${path} must not create or overwrite a file`)
	}
	await invalid.form.getByRole('button', { name: '取消', exact: true }).click()
	await invalid.form.waitFor({ state: 'hidden' })

	await editorEnd()
	const editedPending = nextCompile((files) => files[analysis].includes(marker))
	await page.keyboard.insertText(marker)
	const editedCompile = await compiled(editedPending)
	const edited = editedCompile.files
	assert.deepEqual(
		await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), reportKey),
		baseline,
		'Accepted edits must remain unsaved before the cache test',
	)
	await chooseWorkspaceFile(page, 'data/application.json', 'application-form')
	await current()
	await pairedPreview('application-form')
	assert.equal(await tab('analysis.typ').count(), 1, 'Accepted editing must retain the old tab')
	assert.equal(await tab('analysis.typ').locator('em').count(), 0)
	await tab('analysis.typ').click()
	await assertWorkspaceFile(page, analysis)
	await pairedPreview('report')
	await tab('application.json').click()
	await assertWorkspaceFile(page, 'data/application.json', 'application-form')
	await pairedPreview('application-form')
	assert.equal(page.url(), url)
	await chooseWorkspaceFile(page, analysis)
	await current()
	const cachedText = await page.locator('.workspace-panel:visible .tiptap').textContent()
	assert.ok(cachedText.includes(marker.trim()))
	assert.equal(page.url(), url)

	const creating = await newFile()
	await creating.input.fill(chapter)
	const createdPending = nextCompile(
		(files) => Object.hasOwn(files, chapter) && files[chapter] === '',
	)
	await creating.input.press('Enter')
	await creating.form.waitFor({ state: 'hidden' })
	const createdCompile = await compiled(createdPending)
	const created = createdCompile.files
	await assertWorkspaceFile(page, chapter)
	assert.equal(
		await page.locator('.workspace-panel:visible .tiptap').getAttribute('contenteditable'),
		'true',
	)
	assert.deepEqual(created, { ...edited, [chapter]: '' })

	// Creating a file is one history entry and preserves the older accepted edit.
	const removedPending = nextCompile(
		(files) => !Object.hasOwn(files, chapter) && files[analysis] === edited[analysis],
	)
	await button('撤销').click()
	const removedCompile = await compiled(removedPending)
	assert.deepEqual(removedCompile.files, edited)
	await tab('workspace-notes.typ').waitFor({ state: 'hidden' })
	await chooseWorkspaceFile(page, analysis)
	assert.equal(await workspaceFile(page, chapter).count(), 0)
	const oldUndoPending = nextCompile((files) => files[analysis] === baseline[analysis])
	await button('撤销').click()
	const oldUndoCompile = await compiled(oldUndoPending)
	assert.deepEqual(oldUndoCompile.files, baseline)
	const oldRedoPending = nextCompile((files) => files[analysis] === edited[analysis])
	await button('重做').click()
	const oldRedoCompile = await compiled(oldRedoPending)
	assert.deepEqual(oldRedoCompile.files, edited)
	const recreatePending = nextCompile((files) => Object.hasOwn(files, chapter))
	await button('重做').click()
	const recreateCompile = await compiled(recreatePending)
	assert.deepEqual(recreateCompile.files, created)
	await chooseWorkspaceFile(page, chapter)

	await page
		.locator('.workspace-panel:visible .tiptap p')
		.first()
		.click({ position: { x: 5, y: 10 } })
	const writtenPending = nextCompile((files) => files[chapter]?.includes(chapterText))
	await page.keyboard.insertText(chapterText)
	const writtenCompile = await compiled(writtenPending)
	const written = writtenCompile.files
	assert.equal(written[chapter], chapterText)
	assert.deepEqual(written, { ...created, [chapter]: chapterText })
	const contentUndoPending = nextCompile((files) => files[chapter] === '')
	await button('撤销').click()
	const contentUndoCompile = await compiled(contentUndoPending)
	assert.deepEqual(contentUndoCompile.files, created)
	const contentRedoPending = nextCompile((files) => files[chapter] === chapterText)
	await button('重做').click()
	const contentRedoCompile = await compiled(contentRedoPending)
	assert.deepEqual(contentRedoCompile.files, written)

	await chooseWorkspaceFile(page, analysis)
	await editorEnd()
	await button('插入').click()
	await page.getByRole('option', { name: '插入章节…', exact: true }).click()
	const includeForm = page.getByRole('dialog', { name: '插入章节', exact: true })
	const includePath = includeForm.getByRole('combobox', { name: '章节路径', exact: true })
	await includePath.fill('workspace-n')
	await includeForm.getByRole('option', { name: 'workspace-notes.typ', exact: true }).waitFor()
	const declaration = '#include "workspace-notes.typ"'
	const includedPending = nextCompile((files) => files[analysis]?.includes(declaration))
	await includePath.press('Enter')
	await includeForm.waitFor({ state: 'hidden' })
	const included = await compiled(includedPending)
	assert.equal(included.files[analysis].split(declaration).length, 2)
	assert.ok(included.value.preview.navigation.points.some((point) => point.path === chapter))
	const includedText = await previewText()
	assert.ok(includedText.includes(chapterText), 'Native preview must render the new chapter body')
	for (const [file, source] of Object.entries(written))
		if (file !== analysis) assert.deepEqual(included.files[file], source)
	const includeUndoPending = nextCompile((files) => files[analysis] === written[analysis])
	await button('撤销').click()
	const includeUndoCompile = await compiled(includeUndoPending)
	assert.deepEqual(includeUndoCompile.files, written)
	const includeRedoPending = nextCompile((files) => files[analysis] === included.files[analysis])
	await button('重做').click()
	const includeRedoCompile = await compiled(includeRedoPending)
	assert.deepEqual(includeRedoCompile.files, included.files)

	assert.deepEqual(await snapshot(), included.files)

	const reloadPending = nextCompile((files) => files[chapter] === chapterText)
	await page.reload()
	const reloadCompile = await compiled(reloadPending)
	assert.deepEqual(reloadCompile.files, included.files)
	await assertWorkspaceFile(page, analysis)
	await chooseWorkspaceFile(page, chapter)
	assert.equal(
		await page.locator('.workspace-panel:visible .tiptap').getAttribute('contenteditable'),
		'true',
	)
	assert.equal(await page.locator('.workspace-panel:visible .tiptap p').textContent(), chapterText)
	assert.deepEqual(await snapshot(), included.files)
	assert.equal(await page.evaluate((key) => localStorage.getItem(key), applicationKey), application)
	for (const [file, source] of Object.entries(baseline))
		if (file !== analysis) assert.deepEqual(included.files[file], source)
	assert.deepEqual(Object.keys(included.files).sort(), [...Object.keys(baseline), chapter].sort())

	for (const scheme of ['light', 'dark']) {
		await page.emulateMedia({ colorScheme: scheme })
		await chooseWorkspaceFile(page, chapter)
		await checkTheme(scheme, ['.file-explorer', '.file-row[aria-selected="true"]', '.file-kind'])
		assert.equal(
			await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
			true,
		)
		await page.screenshot({ path: resolve(output, `${scheme}-workspace-files.png`) })
	}
	await page.setViewportSize({ width: 1440, height: 1000 })
	await page.emulateMedia({ colorScheme: 'light' })
	await chooseWorkspaceFile(page, analysis)
	assert.equal(page.url(), url)
	await page.screenshot({ path: resolve(output, 'workspace-created-chapter.png') })
	// Use native draggable tabs to split routed editors, then merge them again.
	const beforeDocking = await snapshot()
	for (const path of [analysis, chapter]) {
		await chooseWorkspaceFile(page, path)
		await button('源码').click()
		const original = await sourceInput.inputValue()
		await sourceInput.fill(`${original}\n// 保留标签以检查原生分屏`)
		await tab(path.split('/').at(-1)).locator('em').waitFor({ state: 'hidden' })
		await button('重新载入当前源码').click()
		await button('结构化编辑').click()
	}
	await tab('analysis.typ').click()
	await assertWorkspaceFile(page, analysis)
	const dragTab = async (name, target) => {
		const bounds = await tab(name).boundingBox()
		await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
		await page.mouse.down()
		await page.mouse.move(bounds.x + bounds.width / 2 + 10, bounds.y + bounds.height / 2 + 10, {
			steps: 3,
		})
		await page.mouse.move(target.x, target.y, { steps: 20 })
		await page.mouse.up()
	}
	const sourceBounds = await page.locator('.workspace-panel:visible').boundingBox()
	await dragTab('workspace-notes.typ', {
		x: sourceBounds.x + sourceBounds.width / 2,
		y: sourceBounds.y + sourceBounds.height - 18,
	})
	await page.waitForFunction(
		() =>
			[...document.querySelectorAll('.workspace-panel')].filter(
				(element) => element.getClientRects().length > 0,
			).length === 2,
	)
	await page.locator('.preview-pane[data-folder="report"]:visible').waitFor()
	await page.screenshot({ path: resolve(output, 'workspace-native-split.png') })
	const analysisTab = await tab('analysis.typ').boundingBox()
	await dragTab('workspace-notes.typ', {
		x: analysisTab.x + analysisTab.width / 2,
		y: analysisTab.y + analysisTab.height / 2,
	})
	await page.waitForFunction(
		() =>
			[...document.querySelectorAll('.workspace-panel')].filter(
				(element) => element.getClientRects().length > 0,
			).length === 1,
	)
	await chooseWorkspaceFile(page, analysis)
	assert.deepEqual(
		await snapshot(),
		beforeDocking,
		'Native split/merge must not change any source bytes',
	)
	const beforePreviewMerge = await page.locator('.source-status').textContent()
	const editorTab = await tab('analysis.typ').boundingBox()
	await dragTab('report · 预览', {
		x: editorTab.x + editorTab.width / 2,
		y: editorTab.y + editorTab.height / 2,
	})
	await page.locator('.preview-pane[data-folder="report"]:visible').waitFor()
	assert.equal(await page.locator('.workspace-panel:visible').count(), 0)
	await tab('analysis.typ').click()
	await assertWorkspaceFile(page, analysis)
	await page.evaluate(
		() =>
			new Promise((resolveFrame) =>
				requestAnimationFrame(() => requestAnimationFrame(resolveFrame)),
			),
	)
	assert.equal(await page.locator('.preview-pane:visible').count(), 0)
	assert.equal(await page.locator('.source-status').textContent(), beforePreviewMerge)
	await page.screenshot({ path: resolve(output, 'workspace-shared-tab-group.png') })
	await tab('report · 预览').click()
	const mergedPreview = page.locator('.preview-pane[data-folder="report"]:visible')
	await mergedPreview.waitFor()
	assert.equal(await page.locator('.workspace-panel:visible').count(), 0)
	const mergedBounds = await mergedPreview.boundingBox()
	await dragTab('report · 预览', {
		x: mergedBounds.x + mergedBounds.width - 18,
		y: mergedBounds.y + mergedBounds.height / 2,
	})
	await page.locator('.workspace-panel[data-file="sections/analysis.typ"]:visible').waitFor()
	await pairedPreview('report')
	assert.deepEqual(await snapshot(), beforeDocking)
	return [
		'原生 Worksplit 临时编辑标签复用，草稿与已编辑标签保留；源码草稿跨标签往返不丢失，未应用时保存和 PDF 受阻，跨项目原生标签激活同步切换右侧主文档预览',
		'源码浮层随所属原生标签隐藏与恢复，隐藏时不覆盖其他文件或抢焦点，返回仍保留未应用草稿且取消不改源码',
		'真实树支持两个根文件夹、目录折叠与键盘打开文件，URL 不变；桌面明暗文字对比度≥4.5且无横向溢出',
		'新建文件建议当前目录，重复路径、越界路径与非 .typ 拒绝且不覆盖；创建可撤销重做，并保留跨文件夹切换前的未保存内容与旧撤销历史',
		'新章节实际输入、内容撤销重做、路径补全 include 均成功，原生预览包含新正文，其他项目文件保持字节不变',
		'新文件保存重载后仍可编辑，章节引用继续进入项目主文档预览，另一个文件夹存储不变',
		'真实拖拽原生标签完成编辑器分屏与归组，源码字节不变',
		'预览与编辑器原生标签可以合入同组并分别激活，自动预览不覆盖当前编辑器或报告焦点错误，拖回相邻组后项目字节不变',
	]
}
