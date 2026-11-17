import assert from 'node:assert/strict'
import { assertWorkspaceFile, chooseWorkspaceFile } from './workspace-ui.mjs'

/** Exercise file insertion through real menus, path completion and native compilation. */
export async function checkSourceFileInput(page, files) {
	const analysis = 'sections/analysis.typ'
	const appendix = 'sections/appendix.typ'
	const button = (name) => page.getByRole('button', { name, exact: true })
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
	const snapshot = async () => {
		await button('保存项目').click()
		await page.waitForFunction(() =>
			[...document.querySelectorAll('[role="status"]')].some((element) =>
				element.textContent.startsWith('已保存源码修订'),
			),
		)
		return page.evaluate(() => JSON.parse(localStorage.getItem('typst-source-project-v2')))
	}
	const editorReady = async (path, title) => {
		await assertWorkspaceFile(page, path)
		await page
			.locator('.workspace-panel:visible .tiptap')
			.getByRole('heading', { name: title, exact: true })
			.waitFor()
		assert.equal(
			await page.locator('.workspace-panel:visible .tiptap').getAttribute('contenteditable'),
			'true',
		)
	}
	const chooseAnalysis = async () => {
		await chooseWorkspaceFile(page, analysis)
		await button('结构化编辑').click()
		await editorReady(analysis, '经营分析')
	}
	const open = async (kind) => {
		await button('插入').click()
		const menu = page.getByRole('listbox', { name: '插入内容', exact: true })
		await menu.getByRole('option', { name: '导入模块…', exact: true }).waitFor()
		await menu.getByRole('option', { name: '插入章节…', exact: true }).waitFor()
		const labels = await menu.getByRole('option').allTextContents()
		assert.equal(
			labels.some((label) => /^导入\s+.*\.typ/.test(label.trim())),
			false,
			'The insert menu must not list an action for every file',
		)
		await menu.getByRole('option', { name: `${kind}…`, exact: true }).click()
		const dialog = page.getByRole('dialog', { name: kind, exact: true })
		await dialog.waitFor()
		return dialog
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
	const compiled = async (pending) => {
		const response = await pending
		const value = await response.json()
		assert.equal(response.ok(), true, `Native /compile failed: ${JSON.stringify(value)}`)
		assert.equal(value.preview?.format, 'vector')
		assert.ok(value.preview.data.length > 0, 'The native vector preview must contain data')
		await current()
		return { value, files: response.request().postDataJSON().files }
	}
	const checkOnlyAnalysisChanged = (actual) => {
		assert.deepEqual(Object.keys(actual).sort(), Object.keys(files).sort())
		for (const [path, contents] of Object.entries(files)) {
			if (path !== analysis) assert.deepEqual(actual[path], contents, `Unexpected write: ${path}`)
		}
	}
	const completesModulePath = async (dialog) => {
		const input = dialog.getByRole('combobox', { name: '模块路径', exact: true })
		const completions = dialog.getByRole('listbox', { name: '路径补全', exact: true })
		await input.focus()
		await completions.waitFor()
		const initial = await completions.getByRole('option').allTextContents()
		for (const name of ['../', 'actions.typ', 'appendix.typ'])
			await completions.getByRole('option', { name, exact: true }).waitFor()
		assert.equal(
			initial.some((name) => /main\.typ|components\/|lib\//.test(name)),
			false,
			'Completion must begin in sections/, without flattening parent directories',
		)
		await input.fill('../c')
		await completions.getByRole('option', { name: 'components/', exact: true }).click()
		assert.equal(await input.inputValue(), '../components/')
		assert.equal(await dialog.isVisible(), true, 'Choosing a directory must keep the form open')
		assert.equal(await dialog.getByRole('alert').count(), 0)
		await input.fill('../c')
		await completions.getByRole('option', { name: 'components/', exact: true }).waitFor()
		await input.press('Tab')
		assert.equal(await input.inputValue(), '../components/')
		await page.keyboard.insertText('bl')
		await completions.getByRole('option', { name: 'blocks.typ', exact: true }).waitFor()
		await input.press('Tab')
		assert.equal(await input.inputValue(), '../components/blocks.typ')
		assert.equal(await dialog.isVisible(), true, 'Tab must complete a file without inserting it')
		return { input, completions }
	}
	const undoInsertion = async () => {
		const pending = nextCompile((candidate) => candidate[analysis] === files[analysis])
		await button('撤销').click()
		const restored = await compiled(pending)
		assert.deepEqual(await snapshot(), files, 'One undo must restore every authored project byte')
		return restored
	}

	assert.equal(typeof files[analysis], 'string')
	assert.equal(
		typeof files[appendix],
		'string',
		'The chapter fixture must be an independent project file',
	)
	await chooseAnalysis()
	await current()
	assert.deepEqual(await snapshot(), files)
	const importsBefore = await page.locator('.workspace-panel:visible .typst-import').count()

	const canceled = await open('导入模块')
	const { input, completions } = await completesModulePath(canceled)
	await input.press('ArrowDown')
	await completions.waitFor()
	await input.press('Escape')
	await completions.waitFor({ state: 'hidden' })
	assert.equal(
		await canceled.isVisible(),
		true,
		'Escape must close completion before closing its form',
	)
	await canceled.getByText('别名或指定成员', { exact: true }).click()
	await canceled.getByRole('textbox', { name: '模块别名', exact: true }).fill('draftBlocks')
	await canceled.getByRole('button', { name: '取消', exact: true }).click()
	await canceled.waitFor({ state: 'hidden' })
	assert.deepEqual(
		await snapshot(),
		files,
		'Canceling path completion must preserve every authored byte',
	)

	const imported = await open('导入模块')
	const modulePath = imported.getByRole('combobox', { name: '模块路径', exact: true })
	const moduleOptions = imported.getByRole('listbox', { name: '路径补全', exact: true })
	await modulePath.fill('../c')
	await moduleOptions.getByRole('option', { name: 'components/', exact: true }).waitFor()
	await modulePath.press('Enter')
	assert.equal(await modulePath.inputValue(), '../components/')
	assert.equal(await imported.isVisible(), true, 'Enter on a directory must only enter it')
	assert.equal(await imported.getByRole('alert').count(), 0)
	assert.equal(await page.locator('.workspace-panel:visible .typst-import').count(), importsBefore)
	await page.keyboard.insertText('bl')
	await moduleOptions.getByRole('option', { name: 'blocks.typ', exact: true }).waitFor()
	const declaration = '#import "../components/blocks.typ"'
	const importResponse = nextCompile((candidate) =>
		candidate[analysis]?.startsWith(`${declaration}\n`),
	)
	await modulePath.press('Enter')
	await imported.waitFor({ state: 'hidden' })
	const importedCompile = await compiled(importResponse)
	const importedFiles = await snapshot()
	assert.deepEqual(importedCompile.files, importedFiles)
	assert.equal(importedFiles[analysis], `${declaration}\n\n${files[analysis]}`)
	checkOnlyAnalysisChanged(importedFiles)
	assert.equal(
		await page.locator('.workspace-panel:visible .typst-import').count(),
		importsBefore + 1,
	)
	const baselineCompile = await undoInsertion()
	assert.equal(
		baselineCompile.value.preview.navigation.outline.filter((item) => item.title === '补充说明')
			.length,
		0,
	)

	const include = '#include "appendix.typ"'
	const readSelection = () =>
		page.locator('.workspace-panel:visible .tiptap').evaluate((element) => {
			const { selection, doc } = element.editor.state
			return { from: selection.from, to: selection.to, size: doc.content.size }
		})
	const checkChapterInsertion = async (prepare, openFile = false) => {
		await page
			.locator('.workspace-panel:visible .tiptap p')
			.last()
			.click({ position: { x: 5, y: 10 } })
		await page.keyboard.press('Control+End')
		// Chromium dispatches selectionchange after the keyboard's DOM caret movement.
		await page.waitForFunction(() => {
			const element = [...document.querySelectorAll('.workspace-panel .tiptap')].find(
				(node) => node.getClientRects().length > 0,
			)
			const editor = element?.editor
			const dom = element?.ownerDocument.getSelection()
			if (!editor || element.ownerDocument.activeElement !== element || !dom?.focusNode)
				return false
			const { selection, doc } = editor.state
			return (
				selection.empty &&
				selection.$from.parent.isTextblock &&
				selection.from === doc.content.size - 1 &&
				editor.view.posAtDOM(dom.focusNode, dom.focusOffset) === selection.from
			)
		})
		const end = await readSelection()
		assert.deepEqual(end, { from: end.size - 1, to: end.size - 1, size: end.size })
		const chapter = await open('插入章节')
		assert.deepEqual(
			await readSelection(),
			end,
			'Opening a chapter form must retain the body caret',
		)
		const chapterPath = chapter.getByRole('combobox', { name: '章节路径', exact: true })
		const options = chapter.getByRole('listbox', { name: '路径补全', exact: true })
		const confirm = await prepare(chapterPath, options, chapter)
		assert.deepEqual(await readSelection(), end, 'Path completion must retain the insertion caret')
		const pending = nextCompile((candidate) => candidate[analysis]?.includes(include))
		await confirm()
		await chapter.waitFor({ state: 'hidden' })
		const chapterCompile = await compiled(pending)
		const chapterFiles = await snapshot()
		assert.deepEqual(chapterCompile.files, chapterFiles)
		checkOnlyAnalysisChanged(chapterFiles)
		assert.equal(
			chapterFiles[analysis].split(include).length - files[analysis].split(include).length,
			1,
			'One confirmation must insert exactly one native include',
		)
		assert.equal(
			chapterFiles[analysis].slice(0, chapterFiles[analysis].indexOf(include)).trimEnd(),
			files[analysis].trimEnd(),
			'A chapter must be inserted at the real end-of-body caret',
		)
		assert.equal(
			chapterCompile.value.preview.navigation.outline.filter((item) => item.title === '补充说明')
				.length,
			1,
		)
		assert.ok(
			chapterCompile.value.preview.navigation.points.some((point) => point.path === appendix),
			'The native preview must contain source points from the included chapter',
		)
		const row = page
			.locator('.workspace-panel:visible .typst-include')
			.filter({ hasText: 'appendix.typ' })
		assert.equal(await row.count(), 1)
		if (openFile) {
			const outline = button('目录')
			if ((await outline.getAttribute('aria-expanded')) !== 'true') await outline.click()
			await page
				.locator('.preview-pane:visible .preview-outline button')
				.filter({ hasText: '补充说明' })
				.waitFor()
			await outline.click()
			await row.getByRole('button', { name: 'appendix.typ', exact: true }).click()
			await editorReady(appendix, '补充说明')
			assert.deepEqual(
				await snapshot(),
				chapterFiles,
				'Opening the included chapter must not rewrite files',
			)
			await chooseAnalysis()
		}
		await undoInsertion()
	}
	await checkChapterInsertion(async (path, options) => {
		await path.fill('appe')
		await options.getByRole('option', { name: 'appendix.typ', exact: true }).waitFor()
		return () => path.press('Enter')
	}, true)
	await checkChapterInsertion(async (path, options) => {
		await path.fill('appe')
		const candidate = options.getByRole('option', { name: 'appendix.typ', exact: true })
		await candidate.waitFor()
		return () => candidate.click()
	})
	await checkChapterInsertion(async (path, options, dialog) => {
		await path.fill('appendix.typ')
		await options.getByRole('option', { name: 'appendix.typ', exact: true }).waitFor()
		await path.press('Escape')
		await options.waitFor({ state: 'hidden' })
		assert.equal(await dialog.isVisible(), true)
		return () => path.press('Enter')
	})

	return [
		'目录点击或 Enter 仅导航，Tab 补全后可配置并取消，全部源码字节不变',
		'最终模块候选一次 Enter 即导入，原生编译成功且仅插入一次，撤销恢复项目字节',
		'章节候选 Enter、鼠标点击与完整路径 Enter 均直接插入一次，原生目录与文件打开正确，每次撤销恢复所有文件',
	]
}
