import assert from 'node:assert/strict'
import { chooseWorkspaceFile } from './workspace-ui.mjs'

function sourcePoint(files, preview, path, text) {
	const source = files[path]
	assert.equal(typeof source, 'string', `Missing source: ${path}`)
	const offset = source.indexOf(text)
	assert.ok(offset >= 0, `Missing navigation text in ${path}: ${text}`)
	const prefix = source.slice(0, offset).split('\n')
	const line = prefix.length
	const column = prefix.at(-1).length + 1
	const point = preview.navigation.points.find(
		(candidate) =>
			candidate.path === path && candidate.line === line && candidate.column === column,
	)
	assert.ok(point, `Native sourcemap is missing ${path}:${line}:${column} (${text})`)
	return { point, text }
}

/** Exercise native preview hits through the actual rendered SVG, without editor commands. */
export async function checkPreviewNavigation(page, files, preview) {
	const analysis = 'sections/analysis.typ'
	const actions = 'sections/actions.typ'
	const editorReady = async (path) => {
		await page.waitForFunction((expected) => {
			const element = [...document.querySelectorAll('.workspace-panel .tiptap')].find(
				(node) => node.getClientRects().length > 0,
			)
			return (
				element?.getAttribute('aria-label') === `Typst 源文件 ${expected}` &&
				element?.editor &&
				!element.editor.isDestroyed
			)
		}, path)
	}
	const clickText = async ({ point, text }) => {
		const pageElement = page.locator('.preview-pane:visible .typst-page').nth(point.page - 1)
		const screenPoint = () =>
			pageElement.evaluate((element, target) => {
				const matrix = element.getScreenCTM()
				const x = target.x + target.width / 2
				const y = target.y + target.height / 2
				return {
					x: matrix.a * x + matrix.c * y + matrix.e,
					y: matrix.b * x + matrix.d * y + matrix.f,
				}
			}, point)
		const before = await screenPoint()
		await page.locator('.preview-pane:visible .preview-scroll').evaluate((element, y) => {
			element.scrollTop += y - element.getBoundingClientRect().top - element.clientHeight / 2
		}, before.y)
		const screen = await screenPoint()
		await page.mouse.click(screen.x, screen.y)
		await page.waitForFunction(
			({ path, expected }) => {
				const element = [...document.querySelectorAll('.workspace-panel .tiptap')].find(
					(node) => node.getClientRects().length > 0,
				)
				if (element?.getAttribute('aria-label') !== `Typst 源文件 ${path}` || !element?.editor)
					return false
				const editor = element.editor
				if (editor.isDestroyed || !editor.isFocused) return false
				const from = editor.state.selection.from
				if (
					editor.state.doc.textBetween(
						from,
						Math.min(from + expected.length, editor.state.doc.content.size),
					) !== expected
				)
					return false
				const caret = editor.view.coordsAtPos(from)
				const bounds = element.closest('.typst-editor-content').getBoundingClientRect()
				return caret.top >= bounds.top && caret.bottom <= bounds.bottom
			},
			{ path: point.path, expected: text },
			{ timeout: 5000 },
		)
	}

	await chooseWorkspaceFile(page, analysis)
	await editorReady(analysis)
	await page.locator('.workspace-panel:visible .typst-editor-content').evaluate((element) => {
		element.scrollTop = 0
	})
	await clickText(sourcePoint(files, preview, analysis, '品牌标记见'))
	assert.ok(
		await page
			.locator('.workspace-panel:visible .typst-editor-content')
			.evaluate((element) => element.scrollTop > 0),
		'Clicking lower body text must scroll the editor from its initial top position',
	)

	await page.getByRole('button', { name: '源码', exact: true }).click()
	await page.getByRole('textbox', { name: '文件源码' }).waitFor()
	await clickText(sourcePoint(files, preview, analysis, '本季度营收增长'))
	await clickText(sourcePoint(files, preview, actions, '营收趋势见'))

	await chooseWorkspaceFile(page, analysis)
	await editorReady(analysis)
	await page.locator('.workspace-panel:visible .typst-editor-content').evaluate((element) => {
		element.scrollTop = 0
	})
	await page.locator('.preview-pane:visible .preview-scroll').evaluate((element) => {
		element.scrollTop = 0
	})
	return [
		'预览点击同文件靠下正文，编辑器聚焦并滚动到对应文字',
		'源码模式点击预览，回到同文件结构化编辑并定位到对应文字',
		'预览点击跨文件文字，切换文件并聚焦可见的对应选区',
	]
}

/** Click real editor glyphs and verify the current compiler's corresponding preview rectangles. */
export async function checkEditorPreviewFollowing(page, files, preview) {
	const analysis = 'sections/analysis.typ'
	const actions = 'sections/actions.typ'
	const clickText = async (text) => {
		await page
			.locator('.workspace-panel:visible .tiptap')
			.getByText(text, { exact: false })
			.first()
			.scrollIntoViewIfNeeded()
		const point = await page
			.locator('.workspace-panel:visible .tiptap')
			.evaluate((element, needle) => {
				const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
				let node
				while ((node = walker.nextNode())) {
					const at = node.textContent.indexOf(needle)
					if (at < 0) continue
					const range = document.createRange()
					range.setStart(node, at)
					range.setEnd(node, at + 1)
					const bounds = range.getBoundingClientRect()
					return { x: bounds.left + 0.2, y: bounds.top + bounds.height / 2 }
				}
				throw new Error(`Editor text missing: ${needle}`)
			}, text)
		await page.mouse.click(point.x, point.y)
		await page.waitForFunction((needle) => {
			const editor = [...document.querySelectorAll('.workspace-panel .tiptap')].find(
				(node) => node.getClientRects().length > 0,
			)?.editor
			if (!editor || editor.isDestroyed) return false
			const from = editor.state.selection.from
			return (
				editor.state.doc.textBetween(
					from,
					Math.min(from + needle.length, editor.state.doc.content.size),
				) === needle
			)
		}, text)
	}
	const highlighted = async (point) => {
		await page.waitForFunction(
			(target) => {
				const highlight = [
					...document.querySelectorAll('.preview-pane .preview-source-highlight'),
				].find((node) => node.getClientRects().length > 0)
				if (!highlight) return false
				const pages = [...document.querySelectorAll('.preview-pane .typst-page')].filter(
					(node) => node.getClientRects().length > 0,
				)
				if (pages.indexOf(highlight.closest('.typst-page')) !== target.page - 1) return false
				const centerX =
					Number(highlight.getAttribute('x')) + Number(highlight.getAttribute('width')) / 2
				const centerY =
					Number(highlight.getAttribute('y')) + Number(highlight.getAttribute('height')) / 2
				if (
					Math.abs(centerX - target.x - target.width / 2) > 1 ||
					Math.abs(centerY - target.y - target.height / 2) > 1
				)
					return false
				const bounds = highlight.getBoundingClientRect()
				const viewport = [...document.querySelectorAll('.preview-pane .preview-scroll')]
					.find((node) => node.getClientRects().length > 0)
					.getBoundingClientRect()
				return (
					bounds.width > 0 &&
					bounds.height > 0 &&
					bounds.top >= viewport.top &&
					bounds.bottom <= viewport.bottom
				)
			},
			point,
			{ timeout: 5000 },
		)
	}
	const current = async () => {
		await page.waitForFunction(
			() =>
				[...document.querySelectorAll('.preview-pane button')].some(
					(button) =>
						button.getClientRects().length > 0 &&
						button.textContent === '下载 PDF' &&
						!button.disabled,
				),
			undefined,
			{ timeout: 45000 },
		)
	}
	const compileResponse = () =>
		page.waitForResponse(
			(response) => new URL(response.url()).pathname === '/compile' && response.ok(),
			{ timeout: 45000 },
		)
	const paragraph = sourcePoint(files, preview, analysis, '本季度营收增长').point

	await chooseWorkspaceFile(page, analysis)
	await page.locator('.preview-pane:visible .preview-scroll').evaluate((element) => {
		element.scrollTop = element.scrollHeight
	})
	await clickText('本季度营收增长')
	await highlighted(paragraph)
	assert.equal(
		await page
			.locator('.workspace-panel:visible .tiptap')
			.evaluate((element) => element.editor.isFocused),
		true,
	)

	await page.locator('.preview-pane:visible .preview-scroll').evaluate((element) => {
		element.scrollTop = element.scrollHeight
	})
	await clickText('本季度营收增长')
	await highlighted(paragraph)
	const follow = page.getByRole('button', { name: '跟随光标', exact: true })
	await follow.click()
	assert.equal(await follow.getAttribute('aria-pressed'), 'false')
	await page.waitForFunction(
		() =>
			![...document.querySelectorAll('.preview-pane .preview-source-highlight')].some(
				(node) => node.getClientRects().length > 0,
			),
		undefined,
		{ timeout: 5000 },
	)
	await clickText('品牌标记见')
	await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)))
	assert.equal(await page.locator('.preview-pane:visible .preview-source-highlight').count(), 0)
	assert.equal(
		await page
			.locator('.workspace-panel:visible .tiptap')
			.evaluate((element) => element.editor.isFocused),
		true,
	)
	await follow.click()
	assert.equal(await follow.getAttribute('aria-pressed'), 'true')
	await highlighted(sourcePoint(files, preview, analysis, '品牌标记见').point)

	await page.locator('.workspace-panel:visible .typst-source-field button').first().click()
	await highlighted(sourcePoint(files, preview, analysis, 'report.field').point)
	await page.keyboard.press('Escape')
	await page.locator('.workspace-panel:visible .typst-component-title').first().click()
	await page.waitForFunction(() =>
		[...document.querySelectorAll('.preview-pane .preview-location-status')].some(
			(element) =>
				element.getClientRects().length > 0 && element.textContent.includes('此处暂不支持预览定位'),
		),
	)
	await page.keyboard.press('Escape')

	await chooseWorkspaceFile(page, actions)
	await page.locator('.preview-pane:visible .preview-scroll').evaluate((element) => {
		element.scrollTop = 0
	})
	await clickText('编号与题注')
	const secondPage = sourcePoint(files, preview, actions, '编号与题注').point
	assert.ok(secondPage.page > 1, 'The cross-page case must actually be on a later rendered page')
	await highlighted(secondPage)

	await chooseWorkspaceFile(page, analysis)
	await clickText('本季度营收增长')
	await highlighted(paragraph)
	const edited = compileResponse()
	await page.keyboard.insertText('跟随验收')
	await page.waitForFunction(() =>
		[...document.querySelectorAll('.preview-pane button')].some(
			(button) =>
				button.getClientRects().length > 0 && button.textContent === '下载 PDF' && button.disabled,
		),
	)
	await page.locator('.preview-pane:visible .preview-scroll').evaluate((element) => {
		element.scrollTop = element.scrollHeight
	})
	const response = await edited
	const packet = await response.json()
	const editedFiles = response.request().postDataJSON().files
	assert.notEqual(editedFiles[analysis], files[analysis])
	await current()
	await highlighted(sourcePoint(editedFiles, packet.preview, analysis, '本季度营收增长').point)

	const undone = compileResponse()
	await page
		.locator('.workspace-panel:visible .typst-editor')
		.getByRole('button', { name: '撤销', exact: true })
		.click()
	const restored = await undone
	assert.deepEqual(restored.request().postDataJSON().files, files)
	await current()
	await page.locator('.workspace-panel:visible .typst-editor-content').evaluate((element) => {
		element.scrollTop = 0
	})
	await page.locator('.preview-pane:visible .preview-scroll').evaluate((element) => {
		element.scrollTop = 0
	})
	return [
		'编辑器真实点击与同光标重复点击，预览跟随并高亮当前文字，编辑焦点保留',
		'关闭跟随时真实点击不定位也不抢焦点，重新开启自动定位当前光标',
		'靠下正文、第二页文字及行内字段按真实编译位置定位，组件无调用位置时明确报告',
		'编辑待编译时禁用旧PDF，新编译显示后自动跟随当前光标，撤销恢复原始源码',
	]
}
