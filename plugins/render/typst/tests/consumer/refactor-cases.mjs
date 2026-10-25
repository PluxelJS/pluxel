import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { trackConsumerSessions } from './browser-session.mjs'

/** Additional real-browser regressions, run by report-example-check.mjs. */
export async function refactorCases({ browser, url, output }) {
	await mkdir(output, { recursive: true })
	const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, hasTouch: true })
	const releaseSessions = trackConsumerSessions(page)
	const errors = []
	const failures = []
	let discard = true
	let beforeUnload = 0
	let latest
	page.on('dialog', (dialog) => {
		if (dialog.type() === 'beforeunload') beforeUnload++
		return discard ? dialog.accept() : dialog.dismiss()
	})
	page.on('pageerror', (error) => errors.push(String(error)))
	page.on('response', async (response) => {
		if (!response.url().endsWith('/compile')) return
		const result = await response.json()
		if (response.ok()) latest = result
		else failures.push(result)
	})
	const tab = (name) => page.getByRole('tab', { name, exact: true }).click()
	const button = (name) => page.getByRole('button', { name, exact: true })
	const body = page.getByTestId('region-body').locator('.tiptap')
	const notes = page.getByTestId('region-notes').locator('.tiptap')
	const source = page.getByLabel('Typst 源码', { exact: true })
	const json = page.getByLabel('外部 JSON 数据', { exact: true })
	const ready = async () => {
		await page
			.getByTestId('revision')
			.filter({ hasText: / · 当前$/ })
			.waitFor({ timeout: 60000 })
		assert.equal(await page.getByRole('alert').count(), 0)
	}
	const documentJson = (locator) => locator.evaluate((element) => element.editor.getJSON())
	const rememberEditor = () =>
		body.evaluate((element) => {
			window.originalEditor = element.editor
		})
	const sameEditor = () => body.evaluate((element) => element.editor === window.originalEditor)
	const stored = () => page.evaluate(() => localStorage.getItem('typst-consumer-draft'))
	const saveState = () => page.getByTestId('save-state').innerText()
	try {
		await page.goto(url)
		await ready()
		await rememberEditor()
		await tab('AI 候选')
		await page.getByLabel('候选目标区域').selectOption('notes')
		const candidate = page.getByLabel('候选 Markdown', { exact: true })
		await candidate.fill('Visible candidate A')
		await button('固定候选目标').click()
		await button('查看修改预览').click()
		assert.match(await page.getByTestId('candidate-review').innerText(), /Notes ready/)
		await candidate.fill('Visible candidate B')
		assert.equal(await button('接纳候选').isDisabled(), true)
		assert.match(await page.getByTestId('candidate-review').innerText(), /Visible candidate B/)
		await button('查看修改预览').click()
		await page.screenshot({ path: join(output, 'candidate-review.png') })
		await button('接纳候选').click()
		await ready()
		assert.equal(await notes.innerText(), 'Visible candidate B')
		await page
			.getByTestId('region-notes')
			.getByRole('button', { name: '撤销', exact: true })
			.click()
		assert.match(await notes.innerText(), /Notes ready/)
		await ready()
		// Ordinary rerender, pure data update and region switches retain the native Editor.
		await page.getByRole('combobox', { name: '客户', exact: true }).selectOption('Beta')
		await ready()
		await tab('正文')
		await button('正文').click()
		assert.equal(await sameEditor(), true)
		await body.locator('p').first().click()
		await page.keyboard.press('End')
		await page.keyboard.insertText(' pending save')
		await ready()
		await button('保存').click()
		assert.equal(await saveState(), '已保存到本浏览器')
		const saved = await stored()
		assert.equal(JSON.parse(saved).draft.data.customer.name, 'Beta')
		await body.locator('p').first().click()
		await page.keyboard.press('End')
		await page.keyboard.insertText(' after baseline')
		await ready()
		assert.equal(await saveState(), '未保存')
		await page.evaluate(() => {
			window.restoreStorage = Storage.prototype.setItem
			Storage.prototype.setItem = function () {
				throw new DOMException('quota fixture', 'QuotaExceededError')
			}
		})
		await button('保存').click()
		assert.equal(await saveState(), '保存失败')
		assert.equal(await stored(), saved)
		await page.screenshot({ path: join(output, 'save-failure.png') })
		await page.evaluate(() => {
			Storage.prototype.setItem = window.restoreStorage
		})
		// Cancelling a replacement preserves identity, content and history.
		discard = false
		const unsaved = await documentJson(body)
		await page.getByLabel('示例', { exact: true }).selectOption('operations-report')
		await page.locator('.workspace-status span').filter({ hasText: '已取消替换' }).waitFor()
		assert.equal(await sameEditor(), true)
		assert.deepEqual(await documentJson(body), unsaved)
		await tab('数据')
		await json.fill('{invalid pending JSON')
		await button('重开').click()
		assert.equal(await json.inputValue(), '{invalid pending JSON')
		assert.equal(await sameEditor(), true)
		// A real reload cancellation also preserves the current document.
		await assert.rejects(page.reload({ waitUntil: 'commit', timeout: 3000 }), /ERR_ABORTED|Timeout/)
		assert.equal(beforeUnload, 1, 'The browser actually prompted before cancelling reload')
		assert.equal(await sameEditor(), true)
		discard = true
		await button('重开').click()
		await ready()
		assert.equal(await sameEditor(), false)
		assert.equal(await page.evaluate(() => window.originalEditor.isDestroyed), true)
		assert.doesNotMatch(await body.innerText(), /after baseline/)
		assert.equal(await body.evaluate((element) => element.editor.can().undo()), false)
		assert.equal(await saveState(), '已保存到本浏览器')
		// Failure diagnostics use their own request mapping, retaining the old picture.
		await tab('模板')
		const validSource = await source.inputValue()
		await source.fill('#let text = "😀"; #let = invalid')
		await page.getByRole('alert').filter({ hasText: 'COMPILE_FAILED' }).waitFor()
		await page
			.getByTestId('revision')
			.filter({ hasText: / · 过期$/ })
			.waitFor()
		assert.equal(await button('导出当前 PDF').isDisabled(), true)
		assert.ok((await page.locator('.typst-page').count()) > 0)
		assert.equal(await saveState(), '未保存')
		const failure = failures.at(-1)
		assert.equal(failure.kind, 'typst')
		assert.ok(failure.mapping.every((item) => item.snapshotRevision === failure.clientRevision))
		const diagnostic = failure.diagnostics.find((item) => item.path === 'main.typ' && item.range)
		assert.ok(diagnostic)
		await button(`定位诊断 ${failure.diagnostics.indexOf(diagnostic) + 1}`).click()
		await page
			.getByTestId('navigation')
			.filter({
				hasText: `source:${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1}`,
			})
			.waitFor()
		assert.equal(
			await source.evaluate((input) => input.selectionStart),
			diagnostic.range.start.character,
		)
		await page.screenshot({ path: join(output, 'template-diagnostic.png') })
		// A late failed response cannot overwrite a newer draft or provide old coordinates.
		let release
		let notify
		let first = true
		const held = new Promise((resolve) => {
			notify = resolve
		})
		const holdFirst = async (route) => {
			if (!first) return route.continue()
			first = false
			const response = await route.fetch()
			await new Promise((resolve) => {
				release = resolve
				notify()
			})
			await route.fulfill({ response })
		}
		await page.route('**/compile', holdFirst)
		await source.fill('#let = rapid_failure')
		await held
		await source.fill(validSource)
		const obsolete = page.locator('.compile-diagnostics button')
		assert.equal(await obsolete.first().isDisabled(), true)
		release()
		await ready()
		await page.unroute('**/compile', holdFirst)
		await source.fill(
			validSource + '\n#set text(font: "Pluxel missing font warning fixture")\nWarning fixture',
		)
		await ready()
		assert.ok(latest.diagnostics.some((item) => item.severity === 'warning'))
		await page.locator('.compile-diagnostics summary').click()
		assert.match(await page.locator('.compile-diagnostics').innerText(), /warning.*font/i)
		await page.screenshot({ path: join(output, 'warning.png') })
		await source.fill(validSource)
		await ready()
		await page.getByLabel('示例', { exact: true }).selectOption('operations-report')
		await ready()
		const chart = body.locator('[data-block-id="channels-primary"]')
		await chart.locator('.typst-block-title').click()
		const title = page.getByLabel('渠道组件标题', { exact: true })
		await title.fill('第一实例标题')
		await button('确认参数').click()
		await ready()
		let content = await documentJson(body)
		assert.equal(
			content.content.find((item) => item.attrs?.id === 'channels-primary').attrs.props.title,
			'第一实例标题',
		)
		const beforeInvalid = JSON.stringify(content)
		await title.fill('')
		await button('确认参数').click()
		await page.getByRole('alert').filter({ hasText: '标题不能为空' }).waitFor()
		assert.equal(JSON.stringify(await documentJson(body)), beforeInvalid)
		await button('取消参数修改').click()
		await chart.getByRole('button', { name: '块操作', exact: true }).click()
		await chart.getByRole('menuitem', { name: '复制一份', exact: true }).click()
		await title.fill('第二实例标题')
		await button('确认参数').click()
		await ready()
		content = await documentJson(body)
		const components = content.content.filter((item) => item.type === 'templateBlock')
		assert.equal(new Set(components.map((item) => item.attrs.id)).size, 2)
		assert.deepEqual(
			components.map((item) => item.attrs.props.title),
			['第一实例标题', '第二实例标题'],
		)
		const undo = page.getByTestId('region-body').getByRole('button', { name: '撤销', exact: true })
		await undo.click()
		const undone = await documentJson(body)
		assert.deepEqual(
			undone.content
				.filter((item) => item.type === 'templateBlock')
				.map((item) => item.attrs.props.title),
			['第一实例标题', '第一实例标题'],
		)
		await page.getByTestId('region-body').getByRole('button', { name: '重做', exact: true }).click()
		await ready()
		await page.screenshot({ path: join(output, 'parameters-desktop.png') })
		await tab('数据')
		const data = JSON.parse(await json.inputValue())
		data.channels[0].actual += 1
		await json.fill(JSON.stringify(data))
		await button('应用 JSON 数据').click()
		await ready()
		assert.deepEqual(await documentJson(body), content)
		await tab('正文')
		await page.getByLabel('区域只读', { exact: true }).check()
		assert.equal(
			await body.evaluate((element) => element.editor.commands.insertTypstSource('')),
			false,
		)
		await page.getByLabel('区域只读', { exact: true }).uncheck()
		await chart.locator('.typst-block-title').click()
		await title.click()
		await title.press('ControlOrMeta+A')
		const cdp = await page.context().newCDPSession(page)
		const composed = '中文参数𠮷'
		await cdp.send('Input.imeSetComposition', {
			text: composed,
			selectionStart: composed.length,
			selectionEnd: composed.length,
		})
		assert.equal(
			await title.evaluate((input) => input.readOnly),
			false,
			'IME keeps the local parameter input writable',
		)
		assert.equal(
			await body.evaluate((element) =>
				element.editor.commands.duplicateTypstTemplateBlock(element.editor.state.selection.from),
			),
			false,
		)
		assert.equal(await button('确认参数').isDisabled(), true)
		await cdp.send('Input.insertText', { text: composed })
		await cdp.detach()
		assert.equal(await title.inputValue(), composed)
		await button('取消参数修改').click()
		// Local parameter drafts belong to instances, not the current native selection.
		await button('保存').click()
		const parametersSaved = await stored()
		await title.fill('第一实例待确认')
		await body.locator('p').first().click()
		await title.waitFor({ state: 'hidden' })
		await button('保存').click()
		assert.equal(await saveState(), '保存失败 · 有未应用输入')
		assert.equal(await stored(), parametersSaved)
		const secondChart = body.locator(`[data-block-id="${components[1].attrs.id}"]`)
		await secondChart.locator('.typst-block-title').click()
		assert.equal(await title.inputValue(), '第二实例标题')
		await title.fill('第二实例待确认')
		await chart.locator('.typst-block-title').click()
		assert.equal(await title.inputValue(), '第一实例待确认')
		await page
			.getByRole('navigation', { name: '正文区域', exact: true })
			.getByRole('button', { name: '后续行动', exact: true })
			.click()
		discard = false
		await button('重开').click()
		await page.locator('.workspace-status span').filter({ hasText: '已取消替换' }).waitFor()
		discard = true
		await page
			.getByRole('navigation', { name: '正文区域', exact: true })
			.getByRole('button', { name: '经营解读', exact: true })
			.click()
		assert.equal(await title.inputValue(), '第一实例待确认')
		await button('取消参数修改').click()
		assert.match(await saveState(), /有未应用输入/)
		await secondChart.locator('.typst-block-title').click()
		assert.equal(await title.inputValue(), '第二实例待确认')
		await button('取消参数修改').click()
		await page.waitForFunction(
			() =>
				!document.querySelector('[data-testid="save-state"]').textContent.includes('有未应用输入'),
		)
		await button('保存').click()
		assert.equal(await saveState(), '已保存到本浏览器')
		await title.fill('确认后的标题')
		await button('确认参数').click()
		await ready()
		assert.equal(await saveState(), '未保存')
		await undo.click()
		await ready()
		assert.equal(await saveState(), '已保存到本浏览器')
		// Explicit node deletion releases its local form; undo restores committed props.
		await secondChart.locator('.typst-block-title').click()
		await title.fill('待删除实例的输入')
		await secondChart.getByRole('button', { name: '块操作', exact: true }).click()
		await secondChart.getByRole('menuitem', { name: '删除', exact: true }).click()
		await ready()
		assert.equal(await saveState(), '未保存')
		await undo.click()
		await ready()
		assert.equal(await saveState(), '已保存到本浏览器')
		// A failed source block maps to its own atom and UTF-16 source coordinate.
		await page
			.getByRole('navigation', { name: '正文区域', exact: true })
			.getByRole('button', { name: '后续行动', exact: true })
			.click()
		const raw = notes.locator('[data-block-id="source-note"]')
		await raw.locator('summary').click()
		const rawInput = raw.getByLabel('组件 Typst 源码', { exact: true })
		const originalRaw = await rawInput.inputValue()
		const beforeSource = await documentJson(notes)
		await button('保存').click()
		await rawInput.fill(`${originalRaw}\n// Unapplied source lifecycle`)
		await raw.getByRole('button', { name: '应用组件修改', exact: true }).click()
		await ready()
		assert.equal(await saveState(), '未保存')
		await page
			.getByTestId('region-notes')
			.getByRole('button', { name: '撤销', exact: true })
			.click()
		await ready()
		assert.equal(await rawInput.inputValue(), originalRaw)
		assert.deepEqual(await documentJson(notes), beforeSource)
		// The raw fixture omits native defaults; this checks input lifetime, not raw JSON equality.
		assert.doesNotMatch(await saveState(), /有未应用输入/)
		await rawInput.fill('#let text = "😀"; #let = invalid')
		discard = false
		await page.getByLabel('示例', { exact: true }).selectOption('consumer-report')
		await page.locator('.workspace-status span').filter({ hasText: '已取消替换' }).waitFor()
		assert.equal(await rawInput.inputValue(), '#let text = "😀"; #let = invalid')
		discard = true
		await raw.getByRole('button', { name: '应用组件修改', exact: true }).click()
		await page.getByRole('alert').filter({ hasText: 'COMPILE_FAILED' }).waitFor()
		const rawFailure = failures.at(-1)
		const rawDiagnostic = rawFailure.diagnostics.find(
			(item) => item.path?.includes('source-note.typ') && item.range,
		)
		assert.ok(rawDiagnostic)
		const mapped = rawFailure.mapping.find(
			(item) => item.path === rawDiagnostic.path && item.sourceStartLine,
		)
		assert.ok(mapped)
		await button(`定位诊断 ${rawFailure.diagnostics.indexOf(rawDiagnostic) + 1}`).click()
		await page.waitForFunction((offset) => {
			const input = document.querySelector('textarea[aria-label="组件 Typst 源码"]')
			return document.activeElement === input && input.selectionStart === offset
		}, rawDiagnostic.range.start.character)
		assert.equal(
			await rawInput.evaluate((input) => input.selectionStart),
			rawDiagnostic.range.start.character,
		)
		assert.equal(await raw.getAttribute('data-selected'), 'true')
		await page.screenshot({ path: join(output, 'component-diagnostic.png') })
		await rawInput.fill(originalRaw)
		await raw.getByRole('button', { name: '应用组件修改', exact: true }).click()
		await ready()
		// Context formatting and mobile pane switches retain selection, history and preview DOM.
		await page
			.getByRole('navigation', { name: '正文区域', exact: true })
			.getByRole('button', { name: '经营解读', exact: true })
			.click()
		await body.locator('p').first().click()
		await rememberEditor()
		const selection = await body.evaluate((element) => element.editor.state.selection.toJSON())
		assert.equal(await page.locator('.typst-typography-panel').count(), 0)
		await page.getByTestId('region-body').getByRole('button', { name: '格式', exact: true }).click()
		await page.getByRole('dialog', { name: '文字格式', exact: true }).waitFor()
		await page.getByRole('button', { name: '关闭格式', exact: true }).click()
		assert.deepEqual(
			await body.evaluate((element) => element.editor.state.selection.toJSON()),
			selection,
		)
		await page.setViewportSize({ width: 390, height: 844 })
		await page.screenshot({ path: join(output, 'mobile-editor.png') })
		const bodyBounds = await body.boundingBox()
		assert.ok(bodyBounds.height > 160, 'Mobile body has useful editing space')
		await page
			.locator('.typst-page')
			.first()
			.evaluate((element) => {
				window.originalPreview = element
			})
		await page
			.getByRole('navigation', { name: '编辑与预览', exact: true })
			.getByRole('button', { name: '预览', exact: true })
			.tap()
		await page.screenshot({ path: join(output, 'mobile-preview.png') })
		await page
			.getByRole('navigation', { name: '编辑与预览', exact: true })
			.getByRole('button', { name: '编辑', exact: true })
			.tap()
		assert.equal(await sameEditor(), true)
		assert.deepEqual(
			await body.evaluate((element) => element.editor.state.selection.toJSON()),
			selection,
		)
		assert.equal(
			await page
				.locator('.typst-page')
				.first()
				.evaluate((element) => element === window.originalPreview),
			true,
		)
		await body.locator('th').first().tap()
		await button('表格操作').tap()
		const menu = page.getByRole('dialog', { name: '表格操作', exact: true })
		await menu.waitFor()
		await page.screenshot({ path: join(output, 'mobile-touch-menu.png') })
		await page.keyboard.press('Escape')
		assert.equal(await menu.isVisible(), false)
		const beforeMobileParameter = await documentJson(body)
		await chart.locator('.typst-block-title').tap()
		await title.fill('窄屏可取消的标题')
		await page.screenshot({ path: join(output, 'mobile-parameters.png') })
		const titleBounds = await title.boundingBox()
		assert.ok(titleBounds.y >= 0 && titleBounds.y + titleBounds.height <= 844)
		await button('取消参数修改').tap()
		assert.deepEqual(await documentJson(body), beforeMobileParameter)
		assert.equal(
			await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
			false,
		)
		await page.setViewportSize({ width: 1440, height: 900 })
		await ready()
		const download = page.waitForEvent('download')
		await button('导出当前 PDF').click()
		const downloaded = await download
		await downloaded.saveAs(join(output, 'final.pdf'))
		assert.deepEqual(errors, [])
		await writeFile(
			join(output, 'result.json'),
			JSON.stringify(
				{
					failures,
					errors,
					clientRevision: latest.clientRevision,
					cases: [
						'candidate text invalidation',
						'save baseline/quota',
						'cancel/confirm replacements and reload',
						'native Editor lifecycle',
						'template/source diagnostics and warning',
						'stale response',
						'instance parameters/history',
						'read-only/IME commands',
						'mobile panes/touch/resource identity',
					],
				},
				null,
				2,
			),
		)
	} catch (error) {
		await page.screenshot({ path: join(output, 'failure.png'), fullPage: true })
		await writeFile(
			join(output, 'failure.json'),
			JSON.stringify(
				{ error: String(error), errors, failures, text: await page.locator('body').innerText() },
				null,
				2,
			),
		)
		throw error
	} finally {
		discard = true
		try {
			await page.goto('about:blank')
			await releaseSessions()
		} finally {
			await page.close()
		}
	}
}
