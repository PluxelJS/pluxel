import { readFileSync } from 'node:fs'
import { chromium } from 'playwright-core'
import { afterEach, expect, it, vi } from 'vitest'
import { candidate, response, settings, setup } from './setup.ts'

const html = readFileSync(new URL('./tax-portal.html', import.meta.url), 'utf8')
afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
})

async function open(scenario = 'matched', attempts = 1) {
	const browser = await chromium.launch({ headless: true })
	const newContext = browser.newContext.bind(browser)
	vi.spyOn(browser, 'newContext').mockImplementation(async (options) => {
		const context = await newContext(options)
		await context.addInitScript((selected) => {
			Object.assign(window, { scenario: selected })
		}, scenario)
		await context.route('**/*', async (route) => {
			const url = route.request().url()
			if (url.startsWith('https://pjcy.mof.gov.cn/')) {
				await route.fulfill({
					contentType: 'text/html',
					body: `<!doctype html><form id="idform"><div><input maxlength="8"></div><div><input maxlength="10"></div><div><input maxlength="6"></div><div><input></div><div class="datePicker"><input></div></form><button class="findbtn" onclick="document.querySelector('.diaVerify').style.display='block'">查验</button><div class="wrapper_billshow" style="display:none"></div><div class="diaVerify" style="display:none">Security challenge</div>`,
				})
				return
			}
			await route.fulfill(
				url.includes('/national-invoice-check')
					? { contentType: 'text/html', body: html }
					: {
							contentType: 'image/svg+xml',
							body: '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="50"><rect width="120" height="50" fill="white"/><text x="10" y="30">ABCD</text></svg>',
						},
			)
		})
		return context
	})
	const fetch = vi.fn(async () => response({ answer: 'ABCD' }))
	vi.stubGlobal('fetch', fetch)
	try {
		return {
			...(await setup({ vlm: settings, captchaAttempts: attempts }, browser)),
			browser,
			fetch,
		}
	} catch (error) {
		await browser.close()
		throw error
	}
}

it('fills tax-inclusive amount and readonly calendar through normal UI, then matches only result DOM', async () => {
	const { host, consumer, browser, fetch } = await open()
	await using _owned = host
	expect(await consumer.verify()).toMatchObject({
		status: 'matched',
		details: {
			kind: 'digital-tax',
			amounts: { totalIncludingTax: '113.00' },
			buyer: { name: '测试购买方' },
			items: [{ name: '测试服务', amount: '100.00', taxAmount: '13.00' }],
		},
		issues: [],
	})
	expect(fetch).toHaveBeenCalledTimes(1)
	const body = JSON.parse(
		(fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string,
	)
	expect(body.messages[0].content[1].image_url.url).toMatch(/^data:image\/png;base64,/)
	expect(body.messages[0].content[0].text).not.toContain('12345678901234567890')
	expect(browser.contexts()).toHaveLength(0)
})

it('waits for an asynchronously refreshed image before sending it to the model', async () => {
	const { host, consumer, browser, fetch } = await open('refresh')
	await using _owned = host
	fetch.mockImplementation(async () => {
		expect(await browser.contexts()[0].pages()[0].locator('img').getAttribute('src')).toBe(
			'/captcha.svg?refresh=1',
		)
		return response({ answer: 'ABCD' })
	})
	expect(await consumer.verify()).toMatchObject({ status: 'matched' })
})

it('retains the observed full red-letter reversal separately from matching invoice fields', async () => {
	const { host, consumer } = await open('reversed')
	await using _owned = host
	expect(await consumer.verify()).toMatchObject({
		status: 'matched',
		redLetterStatus: 'fully_reversed',
	})
})

it.each(['server', 'unknown'])(
	'returns website failure without retrying or inferring forgery: %s',
	async (scenario) => {
		const { host, consumer, browser, fetch } = await open(scenario, 3)
		await using _owned = host
		expect(await consumer.verify()).toMatchObject({ status: 'unconfirmed', reason: 'site_message' })
		expect(fetch).toHaveBeenCalledTimes(scenario === 'server' ? 0 : 1)
		expect(browser.contexts()).toHaveLength(0)
	},
)

it('rejects a result for another invoice', async () => {
	const { host, consumer } = await open('mismatch')
	await using _owned = host
	expect(await consumer.verify()).toEqual({ status: 'unconfirmed', reason: 'identity_mismatch' })
})

it('retries only explicit CAPTCHA rejection and stops at the configured submission bound', async () => {
	const { host, consumer, fetch } = await open('reject', 2)
	await using _owned = host
	expect(await consumer.verify()).toEqual({
		status: 'unconfirmed',
		reason: 'site_message',
		message: '验证码错误',
	})
	expect(fetch).toHaveBeenCalledTimes(2)
})

it('continues after one explicit CAPTCHA rejection', async () => {
	const { host, consumer, fetch } = await open('retry', 2)
	await using _owned = host
	expect(await consumer.verify()).toMatchObject({ status: 'matched' })
	expect(fetch).toHaveBeenCalledTimes(2)
})

it('hands an exhausted automatic CAPTCHA budget to the human once', async () => {
	const { host, consumer, fetch } = await open('retry', 1)
	await using _owned = host
	const onChallenge = vi.fn(async ({ page }) => {
		await page.locator('.t-form-item__yzm input').fill('ABCD')
		await page.getByRole('button', { name: '查 验', exact: true }).click()
	})
	expect(await consumer.verify(undefined, { onChallenge })).toMatchObject({ status: 'matched' })
	expect(fetch).toHaveBeenCalledTimes(1)
	expect(onChallenge).toHaveBeenCalledTimes(1)
})

it('routes fiscal inputs through the internal fiscal adapter', async () => {
	const { host, consumer, browser, fetch } = await open()
	await using _owned = host
	expect(
		await consumer.verify({
			kind: 'fiscal',
			ticket: {
				code: '00123456',
				number: '0012345678',
				checkCode: 'Aa1234',
				issueDate: '2026-07-17',
				amount: '113.00',
			},
		}),
	).toEqual({ status: 'action_required', challenge: 'security_verification' })
	expect(fetch).not.toHaveBeenCalled()
	expect(browser.contexts()).toHaveLength(0)
})

it('supports manual challenge completion with automatic solving disabled', async () => {
	const { host, consumer, fetch } = await open('matched', 0)
	await using _owned = host
	expect(
		await consumer.verify(undefined, {
			onChallenge: async ({ page }) => {
				await page.locator('.t-form-item__yzm input').fill('ABCD')
				await page.getByRole('button', { name: '查 验', exact: true }).click()
			},
		}),
	).toMatchObject({ status: 'matched' })
	expect(fetch).not.toHaveBeenCalled()
})

it('returns action_required and closes the context when no solver/human can act', async () => {
	const { host, consumer, browser } = await open('matched', 0)
	await using _owned = host
	expect(await consumer.verify()).toEqual({
		status: 'action_required',
		challenge: 'security_verification',
	})
	expect(browser.contexts()).toHaveLength(0)
})

it('cancels a non-cooperative human callback and closes its borrowed page', async () => {
	const { host, consumer, browser } = await open('matched', 0)
	await using _owned = host
	const entered = Promise.withResolvers<void>()
	const controller = new AbortController()
	const pending = consumer
		.verify(undefined, {
			signal: controller.signal,
			onChallenge: async () => {
				entered.resolve()
				await new Promise(() => {})
			},
		})
		.catch((error: unknown) => error)
	await entered.promise
	const reason = new Error('User cancelled')
	controller.abort(reason)
	expect(await pending).toBe(reason)
	expect(browser.contexts()).toHaveLength(0)
})

it.each([0, 1])(
	'accepts a text CAPTCHA answer without exposing Page (budget %s)',
	async (attempts) => {
		const { host, consumer, fetch } = await open(attempts ? 'retry' : 'matched', attempts)
		await using _owned = host
		const onCaptcha = vi.fn(async ({ image, instruction, signal }) => {
			expect(image.mimeType).toBe('image/png')
			expect(image.bytes.byteLength).toBeGreaterThan(0)
			expect(instruction).toBe('请输入全部字符')
			expect(signal.aborted).toBe(false)
			return 'ABCD'
		})
		expect(await consumer.verify(undefined, { onCaptcha })).toMatchObject({ status: 'matched' })
		expect(onCaptcha).toHaveBeenCalledTimes(1)
		expect(fetch).toHaveBeenCalledTimes(attempts)
	},
)

it('offers an unclear model CAPTCHA to the text callback once', async () => {
	const { host, consumer, fetch } = await open()
	await using _owned = host
	fetch.mockImplementation(async () => response({ answer: null }))
	const onCaptcha = vi.fn(async () => 'ABCD')
	expect(await consumer.verify(undefined, { onCaptcha })).toMatchObject({ status: 'matched' })
	expect(onCaptcha).toHaveBeenCalledTimes(1)
})

it.each(['image', 'instruction'])(
	'never submits an answer after its %s changes',
	async (changed) => {
		const { host, consumer, browser, fetch } = await open()
		await using _owned = host
		fetch.mockImplementation(async () => {
			await browser
				.contexts()[0]
				.pages()[0]
				.evaluate((field) => {
					if (field === 'image') document.querySelector('img')!.src = '/captcha.svg?new'
					else document.querySelector('.form-box-tip__yzm')!.textContent = '请输入红色字符'
				}, changed)
			return response({ answer: 'ABCD' })
		})
		const onCaptcha = vi.fn(async () => 'ABCD')
		expect(await consumer.verify(undefined, { onCaptcha })).toMatchObject({
			status: 'action_required',
		})
		expect(onCaptcha).not.toHaveBeenCalled()
		expect(browser.contexts()).toHaveLength(0)
	},
)

it('allows declining the text challenge and cleans up', async () => {
	const { host, consumer, browser } = await open('matched', 0)
	await using _owned = host
	expect(await consumer.verify(undefined, { onCaptcha: async () => null })).toMatchObject({
		status: 'action_required',
	})
	expect(browser.contexts()).toHaveLength(0)
})

it('cancels an unanswered text challenge', async () => {
	const { host, consumer, browser } = await open('matched', 0)
	await using _owned = host
	const entered = Promise.withResolvers<void>()
	const controller = new AbortController()
	const pending = consumer
		.verify(undefined, {
			signal: controller.signal,
			onCaptcha: async () => {
				entered.resolve()
				return await new Promise(() => {})
			},
		})
		.catch((error: unknown) => error)
	await entered.promise
	const reason = new Error('Cancelled text challenge')
	controller.abort(reason)
	expect(await pending).toBe(reason)
	expect(browser.contexts()).toHaveLength(0)
})

it('rejects malformed text answers without submitting', async () => {
	const { host, consumer, browser } = await open('matched', 0)
	await using _owned = host
	await expect(
		consumer.verify(undefined, { onCaptcha: async () => 'A B C' }),
	).rejects.toBeInstanceOf(TypeError)
	expect(browser.contexts()).toHaveLength(0)
})

it('does not retry a rejected human text answer', async () => {
	const { host, consumer, fetch } = await open('reject', 0)
	await using _owned = host
	const onCaptcha = vi.fn(async () => 'ABCD')
	expect(await consumer.verify(undefined, { onCaptcha })).toMatchObject({
		status: 'unconfirmed',
		reason: 'site_message',
		message: '验证码错误',
	})
	expect(onCaptcha).toHaveBeenCalledTimes(1)
	expect(fetch).not.toHaveBeenCalled()
})

it('returns official party fields, item tables, totals, remarks and unclassified detail text', async () => {
	const { host, consumer } = await open('merged')
	await using _owned = host
	const result = await consumer.verify()
	expect(result.status).toBe('matched')
	if (result.status !== 'matched') throw new Error('Expected match')
	expect(result.evidence.source).toBe('official-portal')
	expect(result.evidence.truncated).toBe(false)
	expect(result.evidence.fields).toEqual(
		expect.arrayContaining([
			{ section: '购买方信息', label: '名称：', value: '测试购买方' },
			{ section: '销售方信息', label: '名称：', value: '测试销售方' },
			{
				section: '购买方信息',
				label: '统一社会信用代码/纳税人识别号：',
				value: '001234567890123456',
			},
			{ section: '合计', label: '金额', value: '¥100.00' },
			{ section: '合计', label: '税额', value: '¥13.00' },
			{ section: '', label: '备注', value: '测试备注' },
			{ section: '', label: '开票人：', value: '测试员' },
		]),
	)
	expect(result.evidence.tables[0].rows[0][0]).toEqual({
		text: '项目名称',
		header: true,
		rowSpan: 1,
		colSpan: 1,
	})
	expect(result.evidence.tables[0].rows[1].map((cell) => cell.text)).toEqual([
		'测试服务',
		'1',
		'100.00',
		'13%',
		'13.00',
	])
	expect(result.evidence.tables[0].rows[2][0].colSpan).toBe(5)
	expect(result.evidence.text).toContain('未知附加字段：保留此文字')
	expect(result.evidence.text).not.toContain('不要返回按钮文字')
})

it('explicitly marks bounded detail text as truncated without changing identity matching', async () => {
	const { host, consumer } = await open('large')
	await using _owned = host
	const result = await consumer.verify()
	if (result.status !== 'matched') throw new Error('Expected match')
	expect(result.evidence.truncated).toBe(true)
	expect(result.evidence.text).toHaveLength(65536)
})

it('keeps model transcription separate from official data through the public image workflow', async () => {
	const { host, consumer, fetch } = await open()
	await using _owned = host
	fetch.mockResolvedValueOnce(
		response({ ...candidate, totalExcludingTax: '112.00', taxAmount: '1.00' }),
	)
	const result = await consumer.verifyImage()
	if (result.status !== 'completed' || result.verification.status !== 'matched')
		throw new Error('Expected completed match')
	expect(result.extraction.input).toMatchObject({
		kind: 'digital-tax',
		totalIncludingTax: '113.00',
	})
	expect(result.extraction.details).toMatchObject({
		amounts: { totalExcludingTax: '112.00', taxAmount: '1.00' },
		buyer: null,
	})
	expect(result.verification.details).toMatchObject({
		amounts: { totalExcludingTax: '100.00', taxAmount: '13.00' },
		buyer: { name: '测试购买方' },
	})
})
