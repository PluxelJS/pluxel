import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { trackConsumerSessions } from './browser-session.mjs'

// Real clicks in the managed consumer; no browser, compiler, or application is started here.
const output = await mkdtemp(join(tmpdir(), 'typst-source-navigation-'))
const atomsOnly = process.argv.includes('--atoms-only')
const browser = await chromium.connect(
	process.env.PLAYWRIGHT_WS_ENDPOINT ?? 'ws://127.0.0.1:3000',
	{ timeout: 5000, exposeNetwork: '<loopback>' },
)
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
const page = await context.newPage()
const release = trackConsumerSessions(page)
const errors = []
const observations = []
page.on('pageerror', (error) => errors.push(String(error)))
const editor = (regionId) => page.getByTestId(`region-${regionId}`).locator('.tiptap')
const region = (regionId) =>
	page
		.getByRole('navigation', { name: '正文区域', exact: true })
		.getByRole('button', { name: regionId === 'body' ? '经营解读' : '后续行动', exact: true })
		.click()
const tab = (name) => page.getByRole('tab', { name, exact: true }).click()
const settled = () =>
	page.evaluate(
		() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
	)
let compiled
function pointFor(regionId, position) {
	const entry = compiled.mapping.find(
		(item) => item.regionId === regionId && item.kind === 'text' && item.from === position,
	)
	assert.ok(entry, `${regionId}:${position} has a generated character span`)
	const point = compiled.preview.navigation.points.find(
		(item) =>
			item.path === entry.path &&
			item.line === entry.range.start.line &&
			item.column === entry.range.start.column,
	)
	assert.ok(point, `${regionId}:${position} has a native glyph rectangle`)
	return point
}
async function textTarget(regionId, text) {
	const position = await editor(regionId).evaluate((element, needle) => {
		let found
		element.editor.state.doc.descendants((node, offset) => {
			if (node.text?.includes(needle)) found = offset + node.text.indexOf(needle) + 2
		})
		return found
	}, text)
	assert.ok(Number.isInteger(position), `example contains ${text}`)
	return { regionId, text, position, point: pointFor(regionId, position) }
}
async function editorGeometry(target, reveal = false) {
	return editor(target.regionId).evaluate(
		(element, args) => {
			const viewport = element.closest('.typst-editor-content')
			if (args.reveal) {
				const at = element.editor.view.coordsAtPos(args.position)
				viewport.scrollTop += at.top - viewport.getBoundingClientRect().top - 90
			}
			const rect = element.editor.view.coordsAtPos(args.position)
			const bounds = viewport.getBoundingClientRect()
			const selection = window.getSelection()
			return {
				top: rect.top,
				bottom: rect.bottom,
				left: rect.left,
				right: rect.right,
				viewport: {
					top: bounds.top,
					bottom: bounds.bottom,
					left: bounds.left,
					right: bounds.right,
				},
				scrollTop: viewport.scrollTop,
				selection: element.editor.state.selection.toJSON(),
				domSelection: {
					inside: element.contains(selection?.focusNode),
					tag: selection?.focusNode?.parentElement?.tagName,
					offset: selection?.focusOffset,
				},
				visible:
					!element.closest('[hidden]') && rect.top >= bounds.top && rect.bottom <= bounds.bottom,
			}
		},
		{ position: target.position, reveal },
	)
}
async function previewGeometry(point, reveal = false) {
	return page
		.locator('.typst-pages .typst-page')
		.nth(point.page - 1)
		.evaluate(
			(element, args) => {
				const viewport = element.closest('.preview-scroll')
				const center = () =>
					new DOMPoint(
						args.point.x + args.point.width / 2,
						args.point.y + args.point.height / 2,
					).matrixTransform(element.getScreenCTM())
				if (args.reveal) {
					viewport.scrollTop += center().y - viewport.getBoundingClientRect().top - 120
					const x = center().x
					const bounds = viewport.getBoundingClientRect()
					if (x < bounds.left + 20) viewport.scrollLeft += x - bounds.left - 20
					if (x > bounds.right - 20) viewport.scrollLeft += x - bounds.right + 20
				}
				const at = center()
				const bounds = viewport.getBoundingClientRect()
				return {
					x: at.x,
					y: at.y,
					scrollTop: viewport.scrollTop,
					scrollLeft: viewport.scrollLeft,
					viewport: {
						left: bounds.left,
						right: bounds.right,
						top: bounds.top,
						bottom: bounds.bottom,
					},
					visible:
						!element.closest('[hidden]') &&
						at.x >= bounds.left &&
						at.x <= bounds.right &&
						at.y >= bounds.top &&
						at.y <= bounds.bottom,
				}
			},
			{ point, reveal },
		)
}
async function capture(name, target, before, after, valid) {
	observations.push({ name, target, before, after, valid })
	console.log(`${valid ? 'PASS' : 'FAIL'} ${name}`)
	if (
		!valid ||
		name.startsWith('atom-') ||
		name.includes('1.5') ||
		name === 'preview-notes-1328-1' ||
		name === 'rapid-hidden-last-target'
	)
		await page.screenshot({ path: join(output, `${name}.png`), fullPage: true })
}
async function editorToPreview(target, outputTab = 'Typst 预览') {
	await tab('Typst 预览')
	await page.locator('.preview-scroll').evaluate((element, far) => {
		element.scrollTop = far ? element.scrollHeight : 0
	}, target.point.page === 1)
	await region(target.regionId)
	await editorGeometry(target, true)
	await tab(outputTab)
	await settled()
	const screen = await editorGeometry(target)
	assert.ok(screen.visible)
	const before = await previewGeometry(target.point)
	await page.mouse.click(screen.left + 1, (screen.top + screen.bottom) / 2)
	await settled()
	const selection = await editor(target.regionId).evaluate(
		(element) => element.editor.state.selection.from,
	)
	const point = pointFor(target.regionId, selection)
	const pendingTab = await page
		.getByRole('tablist', { name: '文档视图' })
		.getByRole('tab', { selected: true })
		.textContent()
	if (outputTab !== 'Typst 预览') {
		assert.equal(
			pendingTab,
			outputTab,
			'ordinary navigation preserves the source or Markdown workspace',
		)
		await tab('Typst 预览')
		await settled()
	}
	const after = {
		preview: await previewGeometry(point),
		selection,
		navigation: await page.getByTestId('navigation').textContent(),
		outputTab: await page
			.getByRole('tablist', { name: '文档视图' })
			.getByRole('tab', { selected: true })
			.textContent(),
		page: await page.getByTestId('page').textContent(),
		pendingTab,
	}
	await capture(
		`editor-${target.regionId}-${target.position}-${outputTab}-${await page.getByRole('combobox', { name: '缩放', exact: true }).inputValue()}`,
		target,
		before,
		after,
		after.preview.visible &&
			after.outputTab === 'Typst 预览' &&
			after.navigation.startsWith(`preview:${point.path}:`),
	)
}
async function previewToEditor(target) {
	await tab('Typst 预览')
	await region(target.regionId)
	await editor(target.regionId).evaluate((element, far) => {
		const viewport = element.closest('.typst-editor-content')
		viewport.scrollTop = far ? viewport.scrollHeight : 0
	}, target.position < 100)
	await region(target.regionId === 'body' ? 'notes' : 'body')
	await previewGeometry(target.point, true)
	await settled()
	const screen = await previewGeometry(target.point)
	assert.ok(screen.visible)
	const before = await editorGeometry(target)
	await page.evaluate(() => {
		window.sourceClickSelections = []
	})
	await page.mouse.click(screen.x, screen.y)
	await settled()
	const after = {
		editor: await editorGeometry(target),
		navigation: await page.getByTestId('navigation').textContent(),
		activeRegion: await page
			.getByRole('navigation', { name: '正文区域', exact: true })
			.getByRole('button', { pressed: true })
			.textContent(),
		pointerSelections: await page.evaluate(() => window.sourceClickSelections),
	}
	const selection = after.editor.selection.anchor
	await capture(
		`preview-${target.regionId}-${target.position}-${await page.getByRole('combobox', { name: '缩放', exact: true }).inputValue()}`,
		target,
		before,
		after,
		after.editor.visible &&
			selection === target.position &&
			after.navigation === `region:${target.regionId}:${target.position}`,
	)
}
async function rapidPreview(first, last) {
	await tab('Typst 预览')
	await previewGeometry(first.point, true)
	await settled()
	const a = await previewGeometry(first.point)
	const b = await previewGeometry(last.point)
	assert.ok(a.visible && b.visible, 'page boundary places both rapid-click text targets in view')
	await page.mouse.click(a.x, a.y)
	await page.mouse.click(b.x, b.y)
	await settled()
	const after = {
		editor: await editorGeometry(last),
		navigation: await page.getByTestId('navigation').textContent(),
	}
	await capture(
		'rapid-preview-cross-region',
		last,
		{ first, a, b },
		after,
		after.editor.visible &&
			after.editor.selection.anchor === last.position &&
			after.navigation === `region:${last.regionId}:${last.position}`,
	)
}
async function rapidHidden(first, last) {
	await tab('Markdown')
	for (const target of [first, last]) {
		await region(target.regionId)
		const screen = await editorGeometry(target, true)
		await page.mouse.click(screen.left + 1, (screen.top + screen.bottom) / 2)
	}
	assert.equal(
		await page.getByRole('tab', { name: 'Markdown', exact: true }).getAttribute('aria-selected'),
		'true',
	)
	await tab('Typst 预览')
	await settled()
	const after = {
		preview: await previewGeometry(last.point),
		navigation: await page.getByTestId('navigation').textContent(),
	}
	await capture(
		'rapid-hidden-last-target',
		last,
		{ first },
		after,
		after.preview.visible && after.navigation === `preview:${last.point.path}:${last.point.line}`,
	)
}
async function fixedTemplateText() {
	await tab('原始 Typst')
	const source = page.getByRole('textbox', { name: 'Typst 源码', exact: true })
	const padded = '\n'.repeat(80) + (await source.inputValue())
	const response = page.waitForResponse(
		(item) =>
			new URL(item.url()).pathname === '/compile' &&
			item.request().postDataJSON().source === padded,
	)
	await source.fill(padded)
	const compiledResponse = await response
	compiled = await compiledResponse.json()
	assert.equal(compiledResponse.status(), 200, JSON.stringify(compiled))
	await page
		.getByTestId('revision')
		.filter({ hasText: / · 当前$/ })
		.waitFor({ timeout: 60000 })
	const line = padded.split('\n').findIndex((value) => value.includes('渠道经营报告')) + 1
	const point = compiled.preview.navigation.points.find(
		(item) => item.path === 'main.typ' && item.line === line,
	)
	assert.ok(point)
	const offset =
		padded
			.split('\n')
			.slice(0, line - 1)
			.reduce((sum, value) => sum + value.length + 1, 0) +
		point.column -
		1
	await source.evaluate((element) => {
		element.setSelectionRange(0, 0)
		element.scrollTop = 0
	})
	await tab('Typst 预览')
	await previewGeometry(point, true)
	await settled()
	const screen = await previewGeometry(point)
	assert.ok(screen.visible)
	await page.mouse.click(screen.x, screen.y)
	await settled()
	await source.waitFor({ state: 'visible' })
	const after = await source.evaluate((element, expected) => {
		const style = getComputedStyle(element)
		const mirror = document.createElement('div')
		for (const property of [
			'box-sizing',
			'font-family',
			'font-size',
			'font-weight',
			'font-style',
			'line-height',
			'letter-spacing',
			'padding',
			'border-width',
			'border-style',
			'white-space',
			'overflow-wrap',
			'tab-size',
		])
			mirror.style.setProperty(property, style.getPropertyValue(property))
		Object.assign(mirror.style, {
			position: 'fixed',
			left: '-10000px',
			top: '0',
			width: `${element.getBoundingClientRect().width}px`,
		})
		mirror.append(document.createTextNode(element.value.slice(0, expected)))
		const caret = document.createElement('span')
		caret.textContent = element.value.slice(expected, expected + 1) || '|'
		mirror.append(caret)
		document.body.append(mirror)
		const lineTop = caret.getBoundingClientRect().top - mirror.getBoundingClientRect().top
		mirror.remove()
		const bounds = element.getBoundingClientRect()
		const caretTop = bounds.top + lineTop - element.scrollTop
		const caretBottom = caretTop + Number.parseFloat(style.lineHeight)
		return {
			expected,
			selection: element.selectionStart,
			scrollTop: element.scrollTop,
			caretTop,
			caretBottom,
			viewport: { top: bounds.top, bottom: bounds.bottom },
			visible: caretTop >= bounds.top && caretBottom <= bounds.bottom,
		}
	}, offset)
	await capture(
		'preview-fixed-template-distant-line',
		{ line, point, offset },
		{ scrollTop: 0, selection: 0 },
		after,
		after.selection === offset && after.visible,
	)
}
async function atomTarget(regionId, type, identity) {
	const position = await editor(regionId).evaluate(
		(element, args) => {
			let found
			element.editor.state.doc.descendants((node, at) => {
				if (
					found === undefined &&
					node.type.name === args.type &&
					(!args.identity || node.attrs.id === args.identity || node.attrs.target === args.identity)
				)
					found = at
			})
			return found
		},
		{ type, identity },
	)
	assert.ok(Number.isInteger(position), `${type} exists in ${regionId}`)
	const entry = compiled.mapping.find(
		(item) => item.regionId === regionId && item.kind === 'atom' && item.from === position,
	)
	assert.ok(entry, `${type} has its own generated atom mapping`)
	const points = compiled.preview.navigation.points.filter(
		(item) =>
			item.path === entry.path &&
			(item.line > entry.range.start.line ||
				(item.line === entry.range.start.line && item.column >= entry.range.start.column)) &&
			(item.line < entry.range.end.line ||
				(item.line === entry.range.end.line && item.column < entry.range.end.column)),
	)
	assert.ok(points.length, `${type} renders glyphs owned by its own region source span`)
	return { regionId, type, position, entry, points, point: points[0] }
}
async function highlightPosition() {
	const highlight = page.locator('.preview-source-highlight')
	if (!(await highlight.count())) return null
	return highlight.evaluate((element) => ({
		page:
			[...element.closest('.typst-pages').querySelectorAll('.typst-page')].indexOf(
				element.closest('.typst-page'),
			) + 1,
		x: Number(element.getAttribute('x')) + 2,
		y: Number(element.getAttribute('y')) + 2,
	}))
}
async function atomGeometry(target) {
	return editor(target.regionId).evaluate((element, position) => {
		const node = element.editor.view.nodeDOM(position)
		const bounds = node.getBoundingClientRect()
		const viewport = element.closest('.typst-editor-content').getBoundingClientRect()
		return {
			selection: element.editor.state.selection.toJSON(),
			top: bounds.top,
			bottom: bounds.bottom,
			viewport: { top: viewport.top, bottom: viewport.bottom },
			visible:
				!element.closest('[hidden]') &&
				bounds.top >= viewport.top &&
				bounds.bottom <= viewport.bottom,
		}
	}, target.position)
}
async function atomNavigation() {
	await tab('Typst 预览')
	await page.getByRole('combobox', { name: '缩放', exact: true }).selectOption('1')
	const caption = await textTarget('body', '各渠道收入及目标对比')
	const rendered = await page.locator('.typst-pages').textContent()
	assert.ok(
		rendered.split('各渠道收入及目标对比').length >= 3,
		'the original caption is also rendered by references',
	)
	await editorToPreview(caption)
	const captionPoint = await highlightPosition()
	await capture(
		'atom-original-caption',
		caption,
		{ startedAtLastPage: true },
		captionPoint,
		!!captionPoint &&
			captionPoint.page === caption.point.page &&
			Math.abs(captionPoint.x - caption.point.x) < 0.1 &&
			Math.abs(captionPoint.y - caption.point.y) < 0.1,
	)

	const block = await atomTarget('body', 'blockMath', 'attainment-equation')
	const inline = await atomTarget('body', 'inlineMath')
	const reference = await atomTarget('notes', 'reference', 'channels-figure')
	for (const target of [block, inline]) {
		await region(target.regionId)
		await editor(target.regionId).evaluate((element) => {
			element.editor.commands.setTextSelection(23)
			const viewport = element.closest('.typst-editor-content')
			viewport.scrollTop = viewport.scrollHeight
		})
		await region('notes')
		await previewGeometry(target.point, true)
		await settled()
		const screen = await previewGeometry(target.point)
		assert.ok(screen.visible)
		await page.mouse.click(screen.x, screen.y)
		await settled()
		const after = {
			editor: await atomGeometry(target),
			navigation: await page.getByTestId('navigation').textContent(),
		}
		await capture(
			`atom-preview-${target.type}`,
			target,
			{ clicked: screen },
			after,
			after.editor.visible &&
				after.editor.selection.type === 'node' &&
				after.editor.selection.anchor === target.position &&
				after.navigation === `region:${target.regionId}:${target.position}`,
		)
	}
	for (const target of [block, inline, reference]) {
		await region(target.regionId)
		await editor(target.regionId).evaluate(
			(element, stale) => element.editor.chain().focus().setTextSelection(stale).run(),
			target.regionId === 'body' ? 23 : 3,
		)
		await page.locator('.preview-scroll').evaluate((element, firstPage) => {
			element.scrollTop = firstPage ? element.scrollHeight : 0
		}, target.point.page === 1)
		const trigger =
			target.type === 'blockMath'
				? editor('body')
						.locator('[data-equation-id="attainment-equation"]')
						.getByRole('button', { name: '编辑独立公式', exact: true })
				: target.type === 'inlineMath'
					? editor('body').getByRole('button', { name: '编辑行内公式', exact: true }).first()
					: editor('notes').getByRole('button', { name: '引用 fig:channels', exact: true }).first()
		await trigger.click()
		await settled()
		const highlight = await highlightPosition()
		const ownGlyph =
			highlight &&
			target.points.find(
				(point) =>
					highlight.page === point.page &&
					Math.abs(highlight.x - point.x) < 0.1 &&
					Math.abs(highlight.y - point.y) < 0.1,
			)
		const after = {
			preview: await previewGeometry(ownGlyph ?? target.point),
			highlight,
			navigation: await page.getByTestId('navigation').textContent(),
		}
		await capture(
			`atom-editor-${target.type}`,
			target,
			{ oldTextSelection: target.regionId === 'body' ? 23 : 3 },
			after,
			after.preview.visible && !!ownGlyph,
		)
		if (target.type !== 'reference') {
			await editor('body').getByRole('textbox', { name: '公式 LaTeX', exact: true }).press('Escape')
		}
	}
}
try {
	await page.addInitScript(() => {
		window.sourceClickSelections = []
		document.addEventListener(
			'pointerup',
			(event) => {
				if (!event.target.closest?.('.typst-pages')) return
				const selection = window.getSelection()
				window.sourceClickSelections.push({
					tag: selection?.focusNode?.parentElement?.tagName,
					inEditor: !!selection?.focusNode?.parentElement?.closest('.tiptap'),
					text: selection?.focusNode?.textContent?.slice(0, 40),
				})
			},
			true,
		)
	})
	const response = page.waitForResponse((item) => new URL(item.url()).pathname === '/compile')
	await page.goto(process.env.PLUXEL_TYPST_URL ?? 'http://typst.pluxel.localhost:8088')
	const compiledResponse = await response
	compiled = await compiledResponse.json()
	assert.equal(compiledResponse.status(), 200, JSON.stringify(compiled))
	await page
		.getByTestId('revision')
		.filter({ hasText: / · 当前$/ })
		.waitFor({ timeout: 60000 })
	assert.equal(await page.getByRole('alert').count(), 0)
	assert.equal(
		await page.getByRole('combobox', { name: '示例', exact: true }).inputValue(),
		'operations-report',
	)
	const targets = await Promise.all([
		textTarget('body', '结合客户明细核验收入差异'),
		textTarget('body', '其中 A 为实际收入'),
		textTarget('notes', '以下行动计划明确差异复盘'),
		textTarget('notes', '负责人签字，保留核验记录'),
	])
	assert.ok(
		compiled.preview.navigation.pages.length >= 3,
		'the complete example spans at least three pages',
	)
	if (!atomsOnly) {
		for (const target of targets) await editorToPreview(target)
		for (const target of targets.toReversed()) await previewToEditor(target)
		await editorToPreview(targets[3], '原始 Typst')
		await editorToPreview(targets[1], 'Markdown')
		await rapidPreview(targets[1], targets[2])
		await rapidHidden(targets[3], targets[1])
		await tab('Typst 预览')
		await page.getByRole('combobox', { name: '缩放', exact: true }).selectOption('1.5')
		await editorToPreview(targets[3])
		await page.locator('.preview-scroll').evaluate((element) => {
			element.scrollLeft = element.scrollWidth
		})
		await editorToPreview(targets[2])
		await editorToPreview(targets[0])
		for (const target of [targets[0], targets[3]]) await previewToEditor(target)
	}
	await atomNavigation()
	if (!atomsOnly) await fixedTemplateText()
	await writeFile(join(output, 'result.json'), JSON.stringify({ observations, errors }, null, 2))
	console.log(
		JSON.stringify(
			{
				output,
				failed: observations.filter((item) => !item.valid),
				passed: observations.filter((item) => item.valid).map((item) => item.name),
				errors,
			},
			null,
			2,
		),
	)
	assert.deepEqual(errors, [])
	assert.ok(
		observations.every((item) => item.valid),
		'all real source navigation destinations are visible',
	)
} catch (error) {
	await writeFile(join(output, 'result.json'), JSON.stringify({ observations, errors }, null, 2))
	await page.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {})
	console.error(output)
	throw error
} finally {
	try {
		await release()
	} finally {
		await context.close()
		await browser.close()
	}
}
