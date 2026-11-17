import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { trackConsumerSessions } from './browser-session.mjs'
import { assertWorkspaceFile, chooseWorkspaceFile } from './workspace-ui.mjs'

const fixture = await readFile(new URL('./document-private/project.ts', import.meta.url), 'utf8')
const canary = fixture.match(/export const documentSourceCanary = ['"]([^'"]+)['"]/)?.[1]
const entry = fixture.match(/export const documentEntry = ['"]([^'"]+)['"]/)?.[1]
assert.ok(canary && entry, 'Read the private fixture only on the Node side')
const privatePrefix = entry.slice(0, entry.indexOf('/') + 1)
const privateDirectory = fileURLToPath(new URL('./document-private/', import.meta.url))
const sourceSecrets = [
	canary,
	privatePrefix,
	privateDirectory,
	'document-private/project.ts',
	'document-private/server.ts',
]
const forbidden = [
	...sourceSecrets,
	'chapter-background',
	'chapter-approach',
	'chapter-schedule',
	'object-architecture',
]
const endpoint = new URL('/', process.env.PLUXEL_TYPST_URL ?? 'http://typst.pluxel.localhost:8088')
const output = resolve(process.env.TYPST_DOCUMENT_EVIDENCE ?? '/tmp/pluxel-typst-document-evidence')
const sessionUrl = new URL('/document-api/session', endpoint).href
const checks = [],
	evidence = [],
	errors = [],
	violations = [],
	pending = new Set(),
	images = new Map(),
	leases = new Set(),
	opens = []
let latest

function noSource(value, where, nativePdf = false) {
	const text = typeof value === 'string' ? value : JSON.stringify(value)
	for (const secret of nativePdf ? sourceSecrets : forbidden)
		assert.ok(
			!text.includes(secret),
			`${where}: private source marker reached the browser boundary`,
		)
}
function keys(value, allowed, where) {
	assert.ok(value && typeof value === 'object' && !Array.isArray(value), where)
	assert.deepEqual(
		Object.keys(value).filter((key) => !allowed.includes(key)),
		[],
		`${where}: unexpected wire fields`,
	)
}
function semantic(document) {
	assert.equal(document.type, 'doc')
	const visit = (node) => {
		keys(node, ['type', 'attrs', 'marks', 'content', 'text'], `node ${node.type}`)
		assert.equal(typeof node.type, 'string')
		assert.ok(!node.type.startsWith('typst'), `Source node ${node.type} is not semantic content`)
		for (const key of Object.keys(node.attrs ?? {}))
			assert.ok(
				!['source', 'module', 'file', 'path', 'label'].includes(key),
				`Source attribute ${key}`,
			)
		if (node.type === 'documentBlock' || node.type === 'documentInline') {
			keys(node.attrs, ['key', 'title'], 'fixed content')
			assert.equal(node.attrs.title, '固定内容')
			assert.match(node.attrs.key, /^[a-f0-9]{64}$/)
		}
		if (node.type === 'image') assert.equal(node.attrs.src, '/document-api/asset/architecture')
		for (const child of node.content ?? []) visit(child)
	}
	visit(document)
	noSource(document, 'editor JSON')
}
function safeView(view) {
	keys(
		view,
		['revision', 'dirty', 'canUndo', 'canRedo', 'documents', 'references', 'preview', 'issue'],
		'DocumentView',
	)
	assert.ok(Number.isSafeInteger(view.revision) && view.revision >= 0)
	for (const key of ['dirty', 'canUndo', 'canRedo']) assert.equal(typeof view[key], 'boolean')
	assert.ok(Array.isArray(view.documents) && view.documents.length > 0)
	for (const chapter of view.documents) {
		keys(chapter, ['id', 'title', 'editable', 'document'], 'chapter')
		assert.equal(typeof chapter.id, 'string')
		assert.equal(typeof chapter.title, 'string')
		semantic(chapter.document)
	}
	const safeLocation = (location) => {
		keys(location, ['documentId', 'position'], 'semantic location')
		assert.ok(view.documents.some((item) => item.id === location.documentId))
		assert.ok(Number.isSafeInteger(location.position) && location.position >= 0)
	}
	for (const reference of view.references) {
		keys(reference, ['id', 'title', 'kind', 'location'], 'reference')
		assert.match(reference.id, /^[0-9a-f-]{36}$/)
		assert.ok(['heading', 'figure', 'table', 'equation'].includes(reference.kind))
		if (reference.location) safeLocation(reference.location)
	}
	if (view.issue) keys(view.issue, ['code', 'message'], 'public issue')
	if (view.preview) {
		keys(view.preview, ['revision', 'pages', 'points', 'targets', 'links'], 'public preview')
		for (const page of view.preview.pages) {
			keys(page, ['page', 'width', 'height', 'url'], 'public preview page')
			assert.ok(page.width > 0 && page.height > 0)
			const url = new URL(page.url, endpoint)
			assert.equal(url.origin, endpoint.origin)
			assert.equal(url.pathname, '/document-api/page')
		}
		const safePoint = (point) => {
			keys(
				point,
				['documentId', 'position', 'endPosition', 'page', 'x', 'y', 'width', 'height'],
				'preview point',
			)
			assert.ok(view.documents.some((item) => item.id === point.documentId))
			assert.ok(Number.isSafeInteger(point.position) && point.position >= 0)
			assert.ok(Number.isSafeInteger(point.endPosition) && point.endPosition > point.position)
			assert.ok(view.preview.pages.some((item) => item.page === point.page))
			for (const name of ['x', 'y', 'width', 'height'])
				assert.ok(Number.isFinite(point[name]) && point[name] >= 0)
		}
		for (const point of view.preview.points) safePoint(point)
		for (const target of view.preview.targets) {
			keys(target, ['id', 'page', 'x', 'y', 'location'], 'label destination')
			assert.ok(view.references.some((item) => item.id === target.id))
			if (target.location) safeLocation(target.location)
		}
		for (const link of view.preview.links) {
			keys(link, ['page', 'x', 'y', 'width', 'height', 'title', 'target'], 'preview link')
			assert.equal(typeof link.title, 'string')
			for (const name of ['page', 'x', 'y', 'width', 'height'])
				assert.ok(Number.isFinite(link[name]) && link[name] >= 0)
			if (link.target.kind === 'position') {
				keys(link.target, ['kind', 'page', 'x', 'y', 'location'], 'native destination')
				assert.ok(view.preview.pages.some((item) => item.page === link.target.page))
				if (link.target.location) safeLocation(link.target.location)
			} else {
				keys(link.target, ['kind', 'url'], 'public URL')
				assert.match(link.target.url, /^(?:https?:|mailto:|tel:)/)
			}
		}
	}
	noSource(view, 'DocumentView')
}
const chapter = (view, id) => {
	const found = view.documents.find((item) => item.id === id)
	assert.ok(found, `Missing chapter ${id}`)
	return found
}
const nodes = (document, type) => {
	const result = []
	const visit = (node) => {
		if (node.type === type) result.push(node)
		for (const child of node.content ?? []) visit(child)
	}
	visit(document)
	return result
}
const textOf = (node) => node.text ?? (node.content ?? []).map(textOf).join('')
const sameContent = (before, after) => {
	// IDs and protected keys are scoped to the opened project, not persisted content.
	const meaning = (view) => {
		const identities = new Map(
			view.references.map(({ id, ...target }) => [id, JSON.stringify(target)]),
		)
		const node = (value) => ({
			...value,
			...(value.attrs
				? {
						attrs: Object.fromEntries(
							Object.entries(value.attrs).map(([key, data]) => [
								key,
								key === 'key'
									? 'fixed'
									: ['id', 'target'].includes(key) && data
										? (identities.get(data) ?? 'object')
										: data,
							]),
						),
					}
				: {}),
			...(value.content ? { content: value.content.map(node) } : {}),
		})
		return {
			documents: view.documents.map((item) => ({ ...item, document: node(item.document) })),
			references: view.references.map(({ id: _id, ...target }) => target),
		}
	}
	assert.deepEqual(meaning(after), meaning(before))
}
await mkdir(output, { recursive: true })
const browser = await chromium.connect(
	process.env.PLAYWRIGHT_WS_ENDPOINT ?? 'ws://127.0.0.1:3000',
	{ exposeNetwork: '<loopback>', timeout: 5000 },
)
const context = await browser.newContext({
	viewport: { width: 1440, height: 1000 },
	colorScheme: 'light',
	permissions: ['clipboard-read', 'clipboard-write'],
})
const page = await context.newPage()
const releaseSourceSessions = trackConsumerSessions(page)
const button = (name) => page.getByRole('button', { name, exact: true })
const panel = (id) =>
	page.locator(`.document-chapter[data-chapter-id=${JSON.stringify(id)}]:visible`)
const editor = () => page.locator('.document-chapter:visible .tiptap')
const headers = (lease) => ({
	Origin: endpoint.origin,
	'X-Document-Client': lease,
	'Content-Type': 'application/json',
})
const capture = (promise) => {
	pending.add(promise)
	void promise
		.catch((error) => violations.push(String(error)))
		.finally(() => pending.delete(promise))
}
page.on('pageerror', (error) => {
	errors.push(String(error))
	try {
		noSource(String(error), 'page error')
	} catch (failure) {
		violations.push(String(failure))
	}
})
page.on('console', (message) => {
	if (message.type() === 'error') {
		try {
			noSource(message.text(), 'console error')
		} catch (error) {
			violations.push(String(error))
		}
	}
})
page.on('request', (request) => {
	if (new URL(request.url()).origin !== endpoint.origin) return
	try {
		noSource(request.postData() ?? '', 'browser request')
		if (new URL(request.url()).pathname === '/document-api/session') {
			const lease = request.headers()['x-document-client']
			if (lease) leases.add(lease)
			const data = request.postDataJSON()
			if (data.action === 'open') opens.push({ lease, documentId: data.documentId })
		}
	} catch (error) {
		violations.push(String(error))
	}
})
// Read the delivered bytes before fulfillment: Vite's first dependency reload can
// invalidate CDP response handles while the initial module graph is still loading.
await context.route(`${endpoint.origin}/**`, async (route) => {
	const inspecting = (async () => {
		const response = await route.fetch()
		const body = await response.body()
		// Native PDF named destinations retain labels; semantic responses must use opaque IDs.
		noSource(
			body.toString('utf8'),
			`response ${new URL(response.url()).pathname}`,
			response.headers()['content-type']?.startsWith('application/pdf'),
		)
		if (new URL(response.url()).pathname === '/document-api/page' && response.ok()) {
			assert.equal(response.headers()['content-type']?.split(';')[0], 'image/png')
			assert.equal(body.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
			images.set(response.url(), createHash('sha256').update(body).digest('hex'))
		}
		if (
			new URL(response.url()).pathname === '/document-api/session' &&
			response.status() === 200 &&
			response.headers()['content-type']?.includes('application/json')
		) {
			const view = JSON.parse(body.toString('utf8'))
			safeView(view)
			latest = view
		}
		await route.fulfill({ response, body })
	})()
	capture(inspecting)
	await inspecting.catch(() => route.abort().catch(() => {}))
})
async function flushPrivacy() {
	while (pending.size > 0) await Promise.allSettled(pending)
	assert.deepEqual(violations, [])
	const visible = await page.evaluate(() => ({
		dom: document.documentElement.outerHTML,
		documents: [...document.querySelectorAll('.document-chapter .tiptap')].map((element) =>
			element.editor.getJSON(),
		),
		storage: Object.fromEntries(Object.entries(localStorage)),
	}))
	noSource(visible, 'DOM, editor JSON and storage')
	assert.ok(visible.documents.length > 0)
	for (const document of visible.documents) semantic(document)
	assert.match(visible.storage['pluxel-document-demo-id'], /^[0-9a-f-]{36}$/)
}
async function settled(view) {
	safeView(view)
	assert.equal(view.issue, undefined, 'The native document must compile successfully')
	assert.equal(view.preview?.revision, view.revision)
	assert.ok(view.preview.pages.length > 0)
	await page.waitForFunction(
		({ revision, count }) => {
			const preview = document.querySelector('.typst-document-preview')
			const status = document.querySelector('.document-save-state')?.textContent
			const pictures = [...document.querySelectorAll('.typst-document-preview img')]
			return (
				preview?.getAttribute('data-preview-revision') === String(revision) &&
				!/同步|打开/.test(status ?? '') &&
				pictures.length === count &&
				pictures.every((image) => image.complete && image.naturalWidth > 0)
			)
		},
		{ revision: view.revision, count: view.preview.pages.length },
		{ timeout: 45000 },
	)
	await flushPrivacy()
	latest = view
	return view
}
function nextView(action, accept = () => true) {
	return page
		.waitForResponse(
			async (response) => {
				if (response.url() !== sessionUrl || response.status() !== 200) return false
				const request = response.request().postDataJSON()
				return request.action === action && accept(await response.json(), request)
			},
			{ timeout: 45000 },
		)
		.then(async (response) => response.json())
}
async function change(action, act, accept) {
	const [view] = await Promise.all([nextView(action, accept), act()])
	return settled(view)
}
async function revealChapters() {
	const tool = page.getByRole('tab', { name: '章节', exact: true })
	await tool.waitFor()
	if ((await tool.getAttribute('aria-selected')) !== 'true') await tool.click()
	await page.locator('.chapter-explorer:visible').waitFor()
	assert.equal(new URL(page.url()).pathname, '/')
}
async function choose(id) {
	await revealChapters()
	await page
		.locator(`.chapter-list li[data-chapter-id=${JSON.stringify(id)}] .chapter-open`)
		.click()
	await panel(id).waitFor()
	assert.equal(
		await page
			.locator(`.chapter-list li[data-chapter-id=${JSON.stringify(id)}] .chapter-open`)
			.getAttribute('aria-current'),
		'page',
	)
	assert.equal(new URL(page.url()).pathname, '/')
}
async function end() {
	await editor().locator('p').last().click()
	await page.keyboard.press('Control+End')
	assert.equal(await editor().evaluate((element) => element.editor.isFocused), true)
}
function imageHash(view, index = 0) {
	const url = new URL(view.preview.pages[index].url, endpoint).href
	assert.ok(images.has(url), `The browser must load the actual native PNG ${index + 1}`)
	return images.get(url)
}

async function clickEditorText(needle) {
	await editor().getByText(needle, { exact: false }).first().scrollIntoViewIfNeeded()
	const point = await editor().evaluate((element, text) => {
		const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
		let node
		while ((node = walker.nextNode())) {
			const at = node.textContent.indexOf(text)
			if (at < 0) continue
			const range = document.createRange()
			range.setStart(node, at)
			range.setEnd(node, at + 1)
			const bounds = range.getBoundingClientRect()
			return { x: bounds.x + 0.2, y: bounds.y + bounds.height / 2 }
		}
		throw new Error(`Missing editor text ${text}`)
	}, needle)
	await page.mouse.click(point.x, point.y)
	return editor().evaluate((element) => element.editor.state.selection.from)
}

async function highlighted(target) {
	target = { ...target, ...target.location }
	await page.waitForFunction(
		(point) => {
			const highlight = document.querySelector('.typst-document-preview-highlight')
			if (
				!highlight ||
				highlight.getAttribute('data-document-id') !== point.documentId ||
				Number(highlight.getAttribute('data-position')) !== point.position
			)
				return false
			const paper = highlight.closest('[data-document-page]')
			if (Number(paper.getAttribute('data-document-page')) !== point.page) return false
			const bounds = highlight.getBoundingClientRect()
			const viewport = highlight.closest('.typst-document-preview').getBoundingClientRect()
			const image = paper.getBoundingClientRect()
			const expected = {
				x: image.x + (point.x / point.pageWidth) * image.width,
				y: image.y + (point.y / point.pageHeight) * image.height,
			}
			return (
				Math.abs(bounds.x - expected.x) < 1 &&
				Math.abs(bounds.y - expected.y) < 1 &&
				bounds.top >= viewport.top &&
				bounds.top < viewport.bottom &&
				bounds.left >= viewport.left &&
				bounds.left < viewport.right
			)
		},
		{
			...target,
			pageWidth: latest.preview.pages.find((item) => item.page === target.page).width,
			pageHeight: latest.preview.pages.find((item) => item.page === target.page).height,
		},
		{ timeout: 5000 },
	)
}

async function clickPreview(point) {
	const paper = page.locator(`[data-document-page="${point.page}"]`)
	const dimensions = latest.preview.pages.find((item) => item.page === point.page)
	const screenPoint = () =>
		paper.evaluate(
			(element, { point: target, dimensions: size }) => {
				const bounds = element.getBoundingClientRect()
				return {
					x: bounds.x + ((target.x + target.width / 2) / size.width) * bounds.width,
					y: bounds.y + ((target.y + target.height / 2) / size.height) * bounds.height,
				}
			},
			{ point, dimensions },
		)
	const before = await screenPoint()
	await page.locator('.typst-document-preview').evaluate((element, y) => {
		element.scrollTop += y - element.getBoundingClientRect().top - element.clientHeight / 2
	}, before.y)
	const screen = await screenPoint()
	await page.mouse.click(screen.x, screen.y)
}

async function editorAt(chapterId, position) {
	await page.waitForFunction(
		({ id, at }) => {
			const element = [...document.querySelectorAll('.document-chapter .tiptap')].find(
				(item) => item.getClientRects().length > 0,
			)
			if (
				element?.closest('[data-chapter-id]')?.getAttribute('data-chapter-id') !== id ||
				!element.editor?.isFocused ||
				element.editor.state.selection.from !== at
			)
				return false
			const caret = element.editor.view.coordsAtPos(at)
			const viewport = element.closest('.typst-editor-content').getBoundingClientRect()
			return caret.top >= viewport.top && caret.bottom <= viewport.bottom
		},
		{ id: chapterId, at: position },
		{ timeout: 5000 },
	)
}

async function checkNavigation() {
	await choose('background')
	const at = await clickEditorText('本项目关注')
	const body = latest.preview.points.find(
		(point) => point.documentId === 'background' && point.position === at,
	)
	assert.ok(body, 'The real caret must have a native glyph rectangle')
	await highlighted(body)
	await page.locator('.typst-document-preview').evaluate((element) => {
		element.scrollTop = element.scrollHeight
	})
	await clickEditorText('本项目关注')
	await highlighted(body)
	await editorAt('background', at)
	await page.setViewportSize({ width: 1280, height: 850 })
	await highlighted(body)
	await page.setViewportSize({ width: 1440, height: 1000 })
	await highlighted(body)
	const approach = latest.preview.points.find(
		(point) => point.documentId === 'approach' && point.position === 1,
	)
	assert.ok(approach)
	await clickPreview(approach)
	await editorAt('approach', approach.position)
	const schedule = latest.preview.points.find(
		(point) => point.documentId === 'schedule' && point.position === 1,
	)
	assert.ok(schedule)
	await clickPreview(schedule)
	await editorAt('schedule', schedule.position)
	const chapterLink = latest.preview.links.find((link) => link.title === '研究方法')
	assert.ok(chapterLink)
	await clickPreview(chapterLink)
	await highlighted(chapterLink.target)
	await editorAt('schedule', schedule.position)
	const objectLink = latest.preview.links.find((link) => link.title.includes('观察、访谈'))
	assert.ok(objectLink)
	await clickPreview(objectLink)
	await highlighted(objectLink.target)
	await editorAt('schedule', schedule.position)
	const following = button('跟随光标')
	await following.click()
	assert.equal(await following.getAttribute('aria-pressed'), 'false')
	const scroll = await page
		.locator('.typst-document-preview')
		.evaluate((element) => element.scrollTop)
	await clickEditorText('按准备')
	assert.equal(
		await page.locator('.typst-document-preview').evaluate((element) => element.scrollTop),
		scroll,
	)
	await following.click()
	await highlighted(schedule)
	await choose('background')
	await flushPrivacy()
	checks.push(
		'编辑器真实光标与重复点击跟随预览，桌面缩放后仍准确；点预览跨章聚焦可见光标，预览中的章节与图引用跳转且保留编辑器焦点',
	)
}
async function checkSharedWorkspace() {
	const url = page.url()
	const originalWindow = await page.evaluateHandle(() => window)
	const tab = (name) => page.getByRole('tab', { name, exact: true })
	const group = (name) =>
		tab(name).evaluate((element) => {
			const container = element.closest('.flexlayout__tabset')
			if (!container) throw new Error('The document tab must belong to a native central group')
			return container.getAttribute('data-layout-path')
		})
	const dialogs = []
	const dismiss = async (dialog) => {
		dialogs.push(dialog.message())
		await dialog.dismiss()
	}
	page.on('dialog', dismiss)
	async function sameWorkspace() {
		assert.equal(page.url(), url)
		assert.equal(new URL(page.url()).pathname, '/')
		assert.equal(await page.evaluate((original) => original === window, originalWindow), true)
		assert.equal(context.pages().length, 1)
		assert.equal(await page.locator('.flexlayout__layout').count(), 1)
		assert.equal(await page.locator('.flexlayout__tabset:visible').count(), 2)
		assert.deepEqual(dialogs, [], 'Switching retained documents must not prompt to discard input')
	}
	try {
		await chooseWorkspaceFile(page, 'sections/analysis.typ')
		await button('源码').click()
		const input = page.getByRole('textbox', { name: '文件源码', exact: true })
		const original = await input.inputValue()
		const draft = `${original}\n// 统一工作区未应用草稿\n`
		await input.fill(draft)
		await tab('analysis.typ').locator('em').waitFor({ state: 'hidden' })
		const editorGroup = await group('analysis.typ')
		const previewGroup = await group('report · 预览')
		assert.notEqual(editorGroup, previewGroup)
		await sameWorkspace()

		await choose('background')
		assert.equal(await group('项目背景'), editorGroup)
		assert.equal(await group('项目书 · 预览'), previewGroup)
		assert.equal(await group('report · 预览'), previewGroup)
		await end()
		await page.keyboard.press('Enter')
		const marker = '统一工作区正文保持。'
		await change(
			'edit',
			() => page.keyboard.insertText(marker),
			(view) => textOf(chapter(view, 'background').document).includes(marker),
		)
		const saved = await change('save', () => button('保存文档').click())
		assert.equal(saved.dirty, false)
		const downloading = page.waitForEvent('download')
		const pdfButton = page
			.locator('.document-preview:visible')
			.getByRole('button', { name: '下载 PDF', exact: true })
		assert.equal(
			await pdfButton.isEnabled(),
			true,
			'A public source draft must not block document PDF',
		)
		await pdfButton.click()
		const download = await downloading
		assert.equal(download.suggestedFilename(), '项目书.pdf')
		const destination = resolve(output, 'document-with-source-draft.pdf')
		await download.saveAs(destination)
		const pdf = await readFile(destination)
		assert.equal(pdf.subarray(0, 5).toString(), '%PDF-')
		noSource(pdf.toString('utf8'), 'PDF with a public source draft', true)
		await sameWorkspace()

		await tab('analysis.typ').click()
		await assertWorkspaceFile(page, 'sections/analysis.typ')
		assert.equal(await tab('文件').getAttribute('aria-selected'), 'true')
		assert.equal(await tab('report · 预览').getAttribute('aria-selected'), 'true')
		assert.equal(await input.inputValue(), draft)
		assert.equal(await input.getAttribute('data-typst-unapplied'), 'true')
		assert.equal(await button('应用文件源码').isEnabled(), true)
		await sameWorkspace()

		await tab('项目背景').click()
		await panel('background').waitFor()
		assert.equal(await tab('章节').getAttribute('aria-selected'), 'true')
		assert.equal(await tab('项目书 · 预览').getAttribute('aria-selected'), 'true')
		const retained = await editor().textContent()
		assert.ok(retained.includes(marker))
		assert.equal(await group('项目背景'), editorGroup)
		assert.equal(await group('analysis.typ'), editorGroup)
		assert.equal(await group('项目书 · 预览'), previewGroup)
		assert.equal(await group('report · 预览'), previewGroup)
		await sameWorkspace()

		await tab('analysis.typ').click()
		await assertWorkspaceFile(page, 'sections/analysis.typ')
		await button('重新载入当前源码').click()
		assert.equal(await input.inputValue(), original)
		assert.equal(await input.getAttribute('data-typst-unapplied'), null)
		await tab('项目背景').click()
		await panel('background').waitFor()
		await sameWorkspace()
		await flushPrivacy()
		checks.push(
			'同 URL、同 window、唯一 Worksplit 中切换原生文件/章节标签，未应用公开源码草稿完整保留且不挡文档保存/PDF；章节正文往返不丢，两类编辑器共左组、两类预览共右组，无新增分屏',
		)
	} finally {
		page.off('dialog', dismiss)
		await originalWindow.dispose()
	}
}
async function theme(scheme) {
	await page.emulateMedia({ colorScheme: scheme })
	const samples = await page.evaluate(() => {
		const canvas = document.createElement('canvas')
		canvas.width = canvas.height = 1
		const painter = canvas.getContext('2d', { willReadFrequently: true })
		const rgba = (value) => {
			painter.clearRect(0, 0, 1, 1)
			painter.fillStyle = value
			painter.fillRect(0, 0, 1, 1)
			return [...painter.getImageData(0, 0, 1, 1).data].map((part) => part / 255)
		}
		const blend = (top, bottom) =>
			top.slice(0, 3).map((value, index) => value * top[3] + bottom[index] * (1 - top[3]))
		const luminance = (rgb) =>
			rgb.reduce(
				(sum, value, index) =>
					sum +
					(value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4) *
						[0.2126, 0.7152, 0.0722][index],
				0,
			)
		return [
			'main',
			'.chapter-explorer',
			'.chapter-open[aria-current="page"]',
			'.document-chapter',
			'.typst-editor',
			'.document-save-state',
			'.document-preview-toolbar',
		].map((selector) => {
			const element = [...document.querySelectorAll(selector)].find(
				(item) => item.getClientRects().length > 0,
			)
			if (!element) throw new Error(`Missing theme target ${selector}`)
			const ancestors = []
			for (let ancestor = element; ancestor; ancestor = ancestor.parentElement)
				ancestors.unshift(ancestor)
			const back = ancestors.reduce(
				(value, ancestor) => blend(rgba(getComputedStyle(ancestor).backgroundColor), value),
				[1, 1, 1],
			)
			const background = luminance(back),
				foreground = luminance(blend(rgba(getComputedStyle(element).color), back))
			return {
				selector,
				background,
				contrast:
					(Math.max(background, foreground) + 0.05) / (Math.min(background, foreground) + 0.05),
			}
		})
	})
	for (const sample of samples) {
		assert.ok(sample.contrast >= 4.5, `${scheme}: ${JSON.stringify(sample)}`)
		assert.equal(sample.background < 0.1, scheme === 'dark', `${scheme}: ${sample.selector}`)
	}
	assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
	evidence.push({ theme: scheme, samples })
	await page.screenshot({ path: resolve(output, `${scheme}-document.png`) })
}

try {
	const opening = nextView('open')
	await page.goto(endpoint.href)
	await revealChapters()
	const initial = await settled(await opening)
	assert.equal(await page.locator('.flexlayout__layout').count(), 1)
	assert.deepEqual(
		initial.documents.map((item) => item.id),
		['background', 'approach', 'schedule'],
	)
	assert.equal(initial.dirty, false)
	assert.equal(initial.canUndo, false)
	assert.equal(initial.preview.pages.length, 3)
	const initialImage = imageHash(initial)
	await panel('background').waitFor()
	await checkNavigation()
	await editor().locator('p').first().click()
	await page.keyboard.press('Control+Home')
	await page.keyboard.press('End')
	const plain = await change(
		'edit',
		() => page.keyboard.insertText(' 正文验收保持。'),
		(view) => textOf(chapter(view, 'background').document).includes('正文验收保持。'),
	)
	assert.notEqual(imageHash(plain), initialImage)
	const updatedCaret = await editor().evaluate((element) => element.editor.state.selection.from)
	const updatedGlyph = plain.preview.points.find(
		(point) => point.documentId === 'background' && point.position === updatedCaret - 1,
	)
	assert.ok(updatedGlyph, 'The newly typed final character must have current native geometry')
	await highlighted(updatedGlyph)
	const undone = await change('undo', () => button('撤销').click())
	sameContent(initial, undone)
	const redone = await change('redo', () => button('重做').click())
	sameContent(plain, redone)
	await end()
	await page.keyboard.press('Enter')
	await page.keyboard.press('Enter')
	await button('加粗').click()
	const formatted = await change(
		'edit',
		() => page.keyboard.insertText('加粗验收'),
		(view) =>
			nodes(chapter(view, 'background').document, 'text').some(
				(node) =>
					node.text.includes('加粗验收') && node.marks?.some((mark) => mark.type === 'bold'),
			),
	)
	assert.ok(formatted.dirty)
	await button('加粗').click()
	checks.push('真实正文输入与加粗写入服务器语义文档，原生 PNG 随内容变化，一次撤销重做恢复整笔文档')

	await choose('approach')
	const oldApproachImage = imageHash(formatted, 1)
	const cell = editor().locator('table').first().locator('th,td').first().locator('p')
	await cell.click()
	await page.keyboard.press('Home')
	await page.keyboard.press('Shift+End')
	const tableEdited = await change(
		'edit',
		() => page.keyboard.insertText('调查方法核验'),
		(view) => textOf(chapter(view, 'approach').document).includes('调查方法核验'),
	)
	assert.notEqual(imageHash(tableEdited, 1), oldApproachImage)
	await button('编辑行内公式').click()
	const formula = page.getByRole('textbox', { name: '公式 LaTeX', exact: true })
	await formula.fill('p = \\frac{n + 1}{N}')
	const mathEdited = await change(
		'edit',
		() => button('完成').click(),
		(view) =>
			nodes(chapter(view, 'approach').document, 'inlineMath').some(
				(node) => node.attrs.latex === 'p = \\frac{n + 1}{N}',
			),
	)
	assert.notEqual(imageHash(mathEdited, 1), imageHash(tableEdited, 1))
	checks.push('实际表格单元格与 LaTeX 公式可编辑并由原生排版，语义 JSON 与各章真实 PNG 同时变化')

	// Insert before fixed content, then keep typing while the first server edit is in flight.
	await editor().locator('p').first().click()
	await page.keyboard.press('Control+Home')
	await page.keyboard.press('Enter')
	await page.keyboard.press('ArrowUp')
	await page.keyboard.press('Home')
	const firstRequest = page.waitForRequest(
		(request) => request.url() === sessionUrl && request.postDataJSON()?.action === 'edit',
	)
	await page.keyboard.insertText('连续输入第一段。')
	await page.waitForFunction(
		() =>
			[...document.querySelectorAll('.typst-document-preview-surface')].every(
				(element) => element.disabled,
			) && document.querySelectorAll('.typst-document-preview-link').length === 0,
	)
	await firstRequest
	const continuous = await change(
		'edit',
		() => page.keyboard.insertText('继续输入不丢失。'),
		(view) =>
			textOf(chapter(view, 'approach').document).includes('连续输入第一段。继续输入不丢失。'),
	)
	const fixed = nodes(chapter(continuous, 'approach').document, 'documentInline').concat(
		nodes(chapter(continuous, 'approach').document, 'documentBlock'),
	)
	assert.ok(fixed.length > 0)
	checks.push(
		'含固定内容的章节开头插入段落后连续输入，首笔同步期间后续草稿仍被接纳，固定内容保持安全身份',
	)

	await end()
	await page.keyboard.press('Enter')
	await button('插入').click()
	await page.getByRole('option', { name: '表格', exact: true }).click()
	const tableForm = page.getByRole('dialog', { name: '插入表格', exact: true })
	await tableForm.getByRole('spinbutton', { name: '行数', exact: true }).fill('2')
	await tableForm.getByRole('spinbutton', { name: '列数', exact: true }).fill('2')
	const inserted = await change(
		'edit',
		() => tableForm.getByRole('button', { name: '插入表格', exact: true }).click(),
		(view) => nodes(chapter(view, 'approach').document, 'table').length === 2,
	)
	const insertedCell = editor().locator('table').last().locator('th,td').first().locator('p')
	await insertedCell.click()
	await change(
		'edit',
		() => page.keyboard.insertText('新增表格内容'),
		(view) => textOf(chapter(view, 'approach').document).includes('新增表格内容'),
	)
	assert.equal(nodes(chapter(inserted, 'approach').document, 'table').length, 2)
	checks.push('通过普通插入菜单新建表格并输入内容，固定块仍保留且下一笔编辑可继续同步')

	await choose('background')
	const scheduleReference = latest.references.find((reference) => reference.title === '实施计划').id
	const previousReferences = nodes(chapter(latest, 'background').document, 'reference').filter(
		(node) => node.attrs.target === scheduleReference,
	).length
	await end()
	await page.keyboard.press('Enter')
	await page.keyboard.insertText('新增引用：@实施')
	const references = page.getByRole('listbox', { name: '引用章节、图、表或公式', exact: true })
	await references.waitFor()
	let referenced = await change(
		'edit',
		() => references.getByRole('option', { name: '章节 · 实施计划', exact: true }).click(),
		(view) =>
			nodes(chapter(view, 'background').document, 'reference').filter(
				(node) => node.attrs.target === scheduleReference,
			).length ===
			previousReferences + 1,
	)
	await button('引用 实施计划').last().click()
	const policyPosition = await editor().evaluate((element) => element.editor.state.selection.from)
	referenced = await change(
		'edit',
		() => page.getByRole('combobox', { name: '引用显示形式', exact: true }).selectOption('number'),
		(view) =>
			nodes(chapter(view, 'background').document, 'reference').at(-1)?.attrs.showCaption === false,
	)
	const policyGlyph = referenced.preview.points.find(
		(point) => point.documentId === 'background' && point.position === policyPosition,
	)
	assert.ok(policyGlyph, 'Changing reference display must retain native caller navigation')
	const policyLink = referenced.preview.links.find(
		(link) =>
			link.page === policyGlyph.page &&
			link.y <= policyGlyph.y + policyGlyph.height / 2 &&
			link.y + link.height >= policyGlyph.y + policyGlyph.height / 2 &&
			link.x <= policyGlyph.x &&
			link.x + link.width >= policyGlyph.x + policyGlyph.width - 0.01,
	)
	assert.ok(policyLink)
	await clickPreview(policyLink)
	await highlighted(policyLink.target)
	await panel('background').waitFor()
	await button('引用 实施计划').last().click()
	await button('转到引用目标').click()
	await panel('schedule').waitFor()
	assert.equal(latest.revision, referenced.revision, 'Following a reference is not a document edit')
	checks.push(
		'按业务章节名称插入跨章引用并切为仅编号后，原生预览引用与编辑器按钮均可跳转，导航不携带任何源码路径',
	)

	await button('新建章节').click()
	await page.locator('#new-chapter-title').fill('验收补充章节')
	const created = await change('create', () => button('创建章节').click())
	const newChapter = created.documents.find(
		(item) => !referenced.documents.some((before) => before.id === item.id),
	)
	assert.ok(newChapter)
	await panel(newChapter.id).waitFor()
	assert.equal(created.preview.pages.length, 4)
	const createUndo = await change('undo', () => button('撤销').click())
	sameContent(referenced, createUndo)
	const createRedo = await change('redo', () => button('重做').click())
	sameContent(created, createRedo)
	await choose(newChapter.id)
	await editor().locator('p').first().click()
	await page.keyboard.press('Home')
	await page.keyboard.press('Shift+End')
	await change(
		'edit',
		() => page.keyboard.insertText('新章节正文真实保存。'),
		(view) => textOf(chapter(view, newChapter.id).document).includes('新章节正文真实保存。'),
	)
	const title = panel(newChapter.id).getByRole('textbox', { name: '章节名称', exact: true })
	await title.fill('验收补充成果')
	const renamed = await change('rename', () => title.press('Enter'))
	assert.equal(chapter(renamed, newChapter.id).title, '验收补充成果')
	const reordered = await change('reorder', () => button('上移验收补充成果').click())
	assert.deepEqual(
		reordered.documents.map((item) => item.id),
		['background', 'approach', newChapter.id, 'schedule'],
	)
	const movedLink = reordered.preview.links.find((link) => link.title === '实施计划')
	assert.equal(
		movedLink?.target.page,
		4,
		'A chapter move must replace the compiled link destination',
	)
	await clickPreview(movedLink)
	await highlighted(movedLink.target)
	const orderUndo = await change('undo', () => button('撤销').click())
	sameContent(renamed, orderUndo)
	const orderRedo = await change('redo', () => button('重做').click())
	sameContent(reordered, orderRedo)
	checks.push(
		'新建章节自动打开且原生预览增加一页，创建可撤销重做；正文、重命名与章节重排保存为独立事务，重排撤销不丢内容',
	)

	const saved = await change('save', () => button('保存文档').click())
	assert.equal(saved.dirty, false)
	sameContent(orderRedo, saved)
	const previousLease = opens.at(-1)
	const close = await page.request.post(sessionUrl, {
		headers: headers(previousLease.lease),
		data: { action: 'close' },
	})
	assert.equal(close.status(), 204)
	const reopening = nextView('open')
	await page.reload()
	await revealChapters()
	const reopened = await settled(await reopening)
	assert.notEqual(opens.at(-1).lease, previousLease.lease)
	assert.equal(opens.at(-1).documentId, previousLease.documentId)
	assert.equal(reopened.dirty, false)
	sameContent(saved, reopened)
	checks.push(
		'保存后真正关闭服务器 lease，再用新 lease 重载磁盘中的同一 documentId，正文、表格、公式、引用、章节顺序全部恢复',
	)

	const currentLease = opens.at(-1).lease
	for (const [data, status, code] of [
		[
			{
				action: 'edit',
				baseRevision: reopened.revision,
				chapterId: 'missing-chapter',
				document: { type: 'doc', content: [] },
			},
			400,
			'NOT_FOUND',
		],
		[
			{
				action: 'edit',
				baseRevision: reopened.revision,
				chapterId: 'background',
				document: {
					type: 'doc',
					content: [{ type: 'typstInlineSource', attrs: { source: '#let injected = 1' } }],
				},
			},
			400,
			'INVALID_EDIT',
		],
		[{ action: 'save', baseRevision: reopened.revision - 1 }, 409, 'CONFLICT'],
	]) {
		const response = await page.request.post(sessionUrl, { headers: headers(currentLease), data })
		assert.equal(response.status(), status)
		const failure = await response.json()
		keys(failure, ['code', 'message'], 'safe error')
		assert.equal(failure.code, code)
		noSource(failure, 'failed operation')
	}
	for (const path of [
		'/document-private/project.ts?raw',
		'/document-private/server.ts?raw',
		`/@fs${fileURLToPath(new URL('./document-private/project.ts', import.meta.url))}?raw`,
		'/private-proposal/main.typ?raw',
	]) {
		const response = await page.request.get(new URL(path, endpoint).href)
		assert.equal(response.status(), 403, `Private Vite read must fail: ${path}`)
		noSource(await response.text(), 'private raw read error')
	}
	checks.push(
		'不存在章节、注入源码节点和迟到修订均被服务器明确拒绝；错误仅含安全 code/message，私有 Vite/raw/文件路径读取全部 403',
	)

	await choose('approach')
	await page.bringToFront()
	await editor().locator('p').first().click()
	await page.keyboard.press('Control+a')
	await page.keyboard.press('Control+c')
	const clipboard = await page.evaluate(async () => {
		const values = []
		for (const item of await navigator.clipboard.read())
			for (const type of item.types)
				if (type.startsWith('text/')) {
					const data = await item.getType(type)
					values.push({ type, text: await data.text() })
				}
		return values
	})
	assert.ok(
		clipboard.some((item) => item.type === 'text/plain' && item.text.includes('连续输入第一段。')),
	)
	assert.ok(clipboard.some((item) => item.type === 'text/html'))
	noSource(clipboard, 'actual clipboard')
	assert.ok(!/data-typst-(?:source|import|include)/.test(JSON.stringify(clipboard)))
	await editor().locator('p').first().click()
	await flushPrivacy()
	checks.push(
		'实际 Ctrl+C 的 text/plain 与 text/html、全部 DOM/editor JSON/localStorage、所有同源响应与错误均无服务器 canary 或真实私有路径',
	)

	const downloading = page.waitForEvent('download')
	await button('下载 PDF').click()
	const download = await downloading
	assert.equal(download.suggestedFilename(), '项目书.pdf')
	const pdfPath = resolve(output, 'document.pdf')
	await download.saveAs(pdfPath)
	const pdf = await readFile(pdfPath)
	assert.equal(pdf.subarray(0, 5).toString(), '%PDF-')
	noSource(pdf.toString('utf8'), 'exported PDF', true)
	await page
		.locator('.document-preview .typst-document-preview img')
		.nth(1)
		.scrollIntoViewIfNeeded()
	for (const scheme of ['light', 'dark']) await theme(scheme)
	checks.push('桌面明暗主题实际文字对比度≥4.5、无横向溢出，章节和原生页图截图完整，导出实际 PDF')
	await checkSharedWorkspace()
	assert.deepEqual(errors, [])
	await flushPrivacy()
	evidence.push({
		revisions: { initial: initial.revision, saved: saved.revision, reopened: reopened.revision },
		documentId: previousLease.documentId,
		leases: [...leases],
		nativePngCount: images.size,
		clipboardTypes: clipboard.map((item) => item.type),
	})
	await writeFile(
		resolve(output, 'results.json'),
		JSON.stringify({ checks, evidence, errors }, null, 2),
	)
	console.log(JSON.stringify({ output, checks, errors }))
} catch (error) {
	await page.screenshot({ path: resolve(output, 'failure.png'), fullPage: true }).catch(() => {})
	await writeFile(
		resolve(output, 'failure.json'),
		JSON.stringify(
			{ failure: String(error), stack: error.stack, errors, violations, latest, opens },
			null,
			2,
		),
	)
	throw error
} finally {
	await Promise.allSettled(pending)
	for (const lease of leases) {
		const response = await page.request.post(sessionUrl, {
			headers: headers(lease),
			data: { action: 'close' },
		})
		assert.equal(response.status(), 204)
	}
	await releaseSourceSessions()
	await context.close()
	await browser.close()
}
