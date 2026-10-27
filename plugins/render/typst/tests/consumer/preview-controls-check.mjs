import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { trackConsumerSessions } from './browser-session.mjs'

// Real native compilation and SVG geometry, using only the managed app and shared browser.
const output = await mkdtemp(join(tmpdir(), 'typst-preview-controls-'))
const browser = await chromium.connect(
	process.env.PLAYWRIGHT_WS_ENDPOINT ?? 'ws://127.0.0.1:3000',
	{ timeout: 5000, exposeNetwork: '<loopback>' },
)
const observations = []
const errors = []
const mediumOnly = process.argv.includes('--medium-only')
const source = [
	'#set page(width: 400pt, height: 520pt, margin: 30pt)',
	'#set text(font: "DejaVu Sans", size: 11pt)',
	...Array.from({ length: 35 }, (_, index) =>
		[
			index ? '#pagebreak()' : '',
			`= Chapter ${String(index + 1).padStart(2, '0')} — a deliberately long navigation title`,
			`Reading position for chapter ${index + 1}.`,
		].join('\n'),
	),
].join('\n')

async function checkViewport(name, width, height) {
	const context = await browser.newContext({ viewport: { width, height } })
	const page = await context.newPage()
	const release = trackConsumerSessions(page)
	page.on('pageerror', (error) => errors.push({ name, error: String(error) }))
	const viewport = page.locator('.preview-scroll')
	const outline = page.getByRole('navigation', { name: '目录', exact: true })
	const toggle = page.getByRole('button', { name: '目录', exact: true })
	const pager = page.getByRole('spinbutton', { name: '跳转到页', exact: true })
	const zoom = page.getByRole('combobox', { name: '缩放', exact: true })
	const settle = () =>
		page.evaluate(
			() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
		)
	const pageNumber = async () => {
		const text = await page.getByTestId('page').textContent()
		return Number(text.split('/')[0])
	}
	async function current() {
		await page
			.getByTestId('revision')
			.filter({ hasText: / · 当前$/ })
			.waitFor({ timeout: 60000 })
		assert.deepEqual(await page.getByRole('alert').allTextContents(), [])
	}
	async function atPage(number) {
		await page.waitForFunction(
			(expected) =>
				Number(document.querySelector('[data-testid="page"]').textContent.split('/')[0]) ===
				expected,
			number,
		)
		await settle()
	}
	async function goto(number, key = 'Enter') {
		await pager.fill(String(number))
		await pager.press(key)
		await atPage(number)
	}
	async function metrics() {
		return page.evaluate(() => {
			const size = (selector) => {
				const element = document.querySelector(selector)
				const rect = element?.getBoundingClientRect()
				return element
					? {
							x: rect.x,
							y: rect.y,
							width: rect.width,
							height: rect.height,
							clientWidth: element.clientWidth,
							scrollWidth: element.scrollWidth,
							scrollTop: element.scrollTop,
						}
					: null
			}
			return {
				document: size('html'),
				header: size('header'),
				editorHeader: size('.editing .pane-header'),
				previewHeader: size('.output-header'),
				editorToolbar: size('[data-testid="region-body"] .typst-toolbars'),
				editor: size('[data-testid="region-body"] .typst-editor-content'),
				preview: size('.preview-scroll'),
				outline: size('nav[aria-label="目录"]'),
			}
		})
	}
	async function bounded() {
		const measured = await metrics()
		assert.equal(measured.document.scrollWidth, width, 'no whole-page horizontal overflow')
		assert.ok(
			measured.preview.scrollWidth <= measured.preview.clientWidth + 1,
			'fit zoom fits horizontally',
		)
		if (await outline.isVisible()) {
			assert.ok(
				measured.outline.scrollWidth <= measured.outline.clientWidth + 1,
				'outline has no horizontal scrollbar',
			)
			const body = await page.locator('.preview-body').boundingBox()
			assert.ok(
				Math.abs(measured.outline.x + measured.outline.width - body.x - body.width) <= 1,
				'outline stays at the right edge of the preview pane',
			)
		}
	}
	async function activeVisible() {
		await page.waitForFunction(() => {
			const nav = document.querySelector('nav[aria-label="目录"]')
			const active = nav?.querySelector('[aria-current="location"]')
			if (!active || !nav.clientHeight) return false
			const bounds = nav.getBoundingClientRect()
			const rect = active.getBoundingClientRect()
			return (
				rect.top >= bounds.top &&
				rect.bottom <= bounds.bottom &&
				rect.left >= bounds.left &&
				rect.right <= bounds.right
			)
		})
		return outline.locator('[aria-current="location"]').getAttribute('title')
	}
	async function pointGeometry(point, reveal = false) {
		return page
			.locator('.typst-pages .typst-page')
			.nth(point.page - 1)
			.evaluate(
				(element, args) => {
					const scrollArea = element.closest('.preview-scroll')
					const bounds = scrollArea.getBoundingClientRect()
					const screen = () =>
						new DOMPoint(args.point.x, args.point.y).matrixTransform(element.getScreenCTM())
					if (args.reveal) scrollArea.scrollTop += screen().y - bounds.top - 120
					const position = screen()
					return {
						y: position.y - bounds.top,
						x: position.x - bounds.left,
						scrollTop: scrollArea.scrollTop,
					}
				},
				{ point, reveal },
			)
	}
	try {
		await page.goto(process.env.PLUXEL_TYPST_URL ?? 'http://typst.pluxel.localhost:8088')
		await current()
		const initial = await metrics()
		assert.ok(
			initial.editor.height > (name === 'desktop' ? 621.2 + 80 : 282.2 + 160),
			'editor gains meaningful vertical space over baseline',
		)
		await page.screenshot({ path: join(output, `${name}-editor.png`), fullPage: true })
		if (name === 'mobile') await page.getByRole('button', { name: '预览', exact: true }).click()
		await viewport.waitFor({ state: 'visible' })
		await settle()
		assert.equal(await toggle.getAttribute('aria-expanded'), name === 'desktop' ? 'true' : 'false')
		assert.equal(await zoom.inputValue(), 'fit-width')
		const preview = await metrics()
		assert.ok(
			preview.preview.height > (name === 'desktop' ? 641 + 80 : 334 + 160),
			'preview gains meaningful vertical space over baseline',
		)
		await bounded()
		await page.screenshot({ path: join(output, `${name}-preview.png`), fullPage: true })
		if (name === 'mobile') {
			await toggle.click()
			await settle()
			const withOutline = await metrics()
			assert.equal(
				withOutline.preview.width,
				preview.preview.width,
				'mobile outline overlays without compressing preview',
			)
		}
		await viewport.evaluate((element) => {
			element.scrollTop = element.scrollHeight
		})
		await atPage(3)
		const defaultActive = await activeVisible()
		observations.push({
			name,
			check: 'default layout and outline tracking',
			initial,
			preview,
			defaultActive,
		})

		await page.getByRole('tab', { name: '原始 Typst', exact: true }).click()
		const compiledResponse = page.waitForResponse(
			(response) =>
				new URL(response.url()).pathname === '/compile' &&
				response.request().postDataJSON().source === source,
		)
		await page.getByRole('textbox', { name: 'Typst 源码', exact: true }).fill(source)
		const response = await compiledResponse
		const compiled = await response.json()
		assert.equal(response.status(), 200, JSON.stringify(compiled))
		await current()
		assert.equal(compiled.preview.navigation.outline.length, 35)
		await page.getByRole('tab', { name: 'Typst 预览', exact: true }).click()
		await settle()
		if (!(await outline.isVisible())) await toggle.click()
		const longTitle = compiled.preview.navigation.outline.at(-1).title
		assert.equal(
			await outline.getByRole('button', { name: longTitle, exact: true }).getAttribute('title'),
			longTitle,
		)
		assert.equal(
			await outline
				.getByRole('button', { name: longTitle, exact: true })
				.locator('small')
				.textContent(),
			'35',
		)
		await viewport.evaluate((element) => {
			element.scrollTop = element.scrollHeight
		})
		await atPage(35)
		assert.equal(await activeVisible(), longTitle)
		assert.ok(
			await outline.evaluate((element) => element.scrollTop > 0),
			'active item scrolls into the long outline',
		)
		await bounded()
		const beforeManual = await viewport.evaluate((element) => element.scrollTop)
		await outline.hover()
		await page.mouse.wheel(0, -10000)
		await page.waitForFunction(
			() => document.querySelector('nav[aria-label="目录"]').scrollTop === 0,
		)
		assert.equal(
			await viewport.evaluate((element) => element.scrollTop),
			beforeManual,
			'manual outline scrolling cannot move document',
		)
		await goto(34)
		await activeVisible()
		await goto(35)
		await activeVisible()
		await page.screenshot({ path: join(output, `${name}-long-outline.png`), fullPage: true })
		observations.push({
			name,
			check: '35 native chapters follow document scroll; manual TOC scroll is isolated',
		})

		await goto(1)
		assert.equal(await page.getByRole('button', { name: '上一页', exact: true }).isDisabled(), true)
		assert.equal(
			await page.getByRole('button', { name: '下一页', exact: true }).isDisabled(),
			false,
		)
		await goto(3, 'Tab')
		for (const invalid of ['0', '36', '2.5', '']) {
			await pager.fill(invalid)
			await pager.press('Enter')
			await settle()
			assert.equal(await pageNumber(), 3)
			await pager.press('Escape')
			assert.equal(await pager.inputValue(), '3')
		}
		await pager.fill('8')
		await pager.press('Escape')
		assert.equal(await pageNumber(), 3)
		await pager.fill('7')
		await viewport.evaluate((element) => {
			element.scrollTop = element.scrollHeight
		})
		await atPage(35)
		assert.equal(await pager.inputValue(), '7', 'scrolling preserves the focused page-number draft')
		await pager.press('Escape')
		assert.equal(await pager.inputValue(), '35')
		assert.equal(await page.getByRole('button', { name: '下一页', exact: true }).isDisabled(), true)
		observations.push({
			name,
			check:
				'page input Enter/blur, invalid values, Escape, draft preservation and disabled boundaries',
		})

		// Keep a real compiled heading at a stable reading line, away from document edges.
		const anchor = compiled.preview.navigation.outline[17]
		await pointGeometry(anchor, true)
		await atPage(18)
		const before = await pointGeometry(anchor)
		assert.ok(Math.abs(before.y - 120) < 2)
		const anchors = []
		for (let index = 0; index < 2; index += 1) {
			await toggle.click()
			await settle()
			const after = await pointGeometry(anchor)
			assert.ok(
				Math.abs(after.y - before.y) < 2,
				`outline toggle keeps the real heading position: ${JSON.stringify(after)}`,
			)
			anchors.push({ toggle: index, after })
		}
		for (const scale of ['fit-page', '0.5', '0.75', '1', '1.25', '1.5', '2', 'fit-width']) {
			await zoom.selectOption(scale)
			await settle()
			assert.equal(await zoom.inputValue(), scale)
			assert.equal(await pageNumber(), 18)
			const after = await pointGeometry(anchor)
			assert.ok(
				Math.abs(after.y - before.y) < 2,
				`${scale} keeps the real heading position: ${JSON.stringify(after)}`,
			)
			if (scale.startsWith('fit')) await bounded()
			anchors.push({ scale, after })
		}
		await page.screenshot({ path: join(output, `${name}-anchor.png`), fullPage: true })
		observations.push({
			name,
			check: 'TOC toggles and all zoom choices retain a real native reading position',
			anchors,
		})
	} catch (error) {
		await page
			.screenshot({ path: join(output, `${name}-failure.png`), fullPage: true })
			.catch(() => {})
		throw error
	} finally {
		await release()
		await context.close()
	}
}

async function checkMediumDark() {
	const context = await browser.newContext({
		viewport: { width: 1024, height: 768 },
		colorScheme: 'dark',
	})
	const page = await context.newPage()
	const release = trackConsumerSessions(page)
	page.on('pageerror', (error) => errors.push({ name: 'medium-dark', error: String(error) }))
	const viewport = page.locator('.preview-scroll')
	const outline = page.getByRole('navigation', { name: '目录', exact: true })
	const toggle = page.getByRole('button', { name: '目录', exact: true })
	const pager = page.getByRole('spinbutton', { name: '跳转到页', exact: true })
	const zoom = page.getByRole('combobox', { name: '缩放', exact: true })
	try {
		await page.goto(process.env.PLUXEL_TYPST_URL ?? 'http://typst.pluxel.localhost:8088')
		await page
			.getByTestId('revision')
			.filter({ hasText: / · 当前$/ })
			.waitFor({ timeout: 60000 })
		assert.deepEqual(await page.getByRole('alert').allTextContents(), [])
		assert.equal(
			await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches),
			true,
		)
		assert.equal(await toggle.getAttribute('aria-expanded'), 'false')
		assert.equal(await outline.isVisible(), false)
		for (const control of [
			page.getByRole('combobox', { name: '示例', exact: true }),
			page.getByRole('checkbox', { name: '区域只读', exact: true }),
			...['保存', '重开', '导出当前 PDF'].map((name) =>
				page.getByRole('button', { name, exact: true }),
			),
			toggle,
			pager,
			zoom,
		]) {
			assert.equal(await control.isVisible(), true, `${control} remains visible`)
			assert.equal(await control.isEnabled(), true)
			const bounds = await control.boundingBox()
			assert.ok(
				bounds.x >= 0 &&
					bounds.y >= 0 &&
					bounds.x + bounds.width <= 1024 &&
					bounds.y + bounds.height <= 768,
				'top actions and navigation stay inside the viewport',
			)
		}
		await page.getByRole('button', { name: '下一页', exact: true }).click()
		await page
			.getByTestId('page')
			.filter({ hasText: /^2 \/ 3$/ })
			.waitFor()
		await pager.fill('1')
		await pager.press('Enter')
		await page
			.getByTestId('page')
			.filter({ hasText: /^1 \/ 3$/ })
			.waitFor()
		await zoom.selectOption('fit-page')
		await zoom.selectOption('fit-width')
		const before = await viewport.boundingBox()
		await page.screenshot({ path: join(output, 'medium-dark-preview.png'), fullPage: true })
		await toggle.click()
		await outline.waitFor({ state: 'visible' })
		const after = await viewport.boundingBox()
		assert.equal(
			after.width,
			before.width,
			'medium-width outline is an overlay, not a narrower document column',
		)
		assert.equal(
			await outline.evaluate((element) => getComputedStyle(element).position),
			'absolute',
		)
		await page.screenshot({ path: join(output, 'medium-dark-outline.png'), fullPage: true })
		await page.getByRole('tab', { name: 'Markdown', exact: true }).click()
		await page.getByRole('textbox', { name: '实时 Markdown', exact: true }).waitFor()
		await page.getByRole('tab', { name: '原始 Typst', exact: true }).click()
		await page.getByRole('textbox', { name: 'Typst 源码', exact: true }).waitFor()
		await page.getByRole('tab', { name: 'Typst 预览', exact: true }).click()
		await toggle.click()
		assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 1024)
		const geometry = await viewport.evaluate((element) => ({
			width: element.clientWidth,
			scrollWidth: element.scrollWidth,
			height: element.clientHeight,
		}))
		assert.equal(geometry.scrollWidth, geometry.width)
		observations.push({
			name: 'medium-dark',
			check:
				'1024px starts with TOC closed; reachable actions, page/zoom interaction, overlay width and Markdown/source tabs',
			geometry,
		})
	} catch (error) {
		await page
			.screenshot({ path: join(output, 'medium-dark-failure.png'), fullPage: true })
			.catch(() => {})
		throw error
	} finally {
		await release()
		await context.close()
	}
}

try {
	if (!mediumOnly) {
		await checkViewport('desktop', 1440, 1000)
		await checkViewport('mobile', 390, 844)
	}
	await checkMediumDark()
	assert.deepEqual(errors, [])
	await writeFile(join(output, 'result.json'), JSON.stringify({ observations, errors }, null, 2))
	console.log(JSON.stringify({ result: 'passed', output, observations, errors }, null, 2))
} catch (error) {
	await writeFile(join(output, 'failure.json'), JSON.stringify({ observations, errors }, null, 2))
	console.error(JSON.stringify({ output, observations, errors }, null, 2))
	throw error
} finally {
	await browser.close()
}
