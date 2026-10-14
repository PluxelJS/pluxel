import { BasePlugin, Plugin } from '@pluxel/core'
import { PlaywrightPlugin } from '@pluxel/playwright'
import { createTestHost } from '@pluxel/test'
import { chromium } from 'playwright-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { InvoicePlugin, type FiscalTicketInput, type InvoiceOptions } from '../src/index.ts'
import { BrowserFixture } from './fixtures/browser.ts'

const ticket: FiscalTicketInput = {
	code: '12345678',
	number: '0012345678',
	checkCode: 'Ab12C3',
	amount: '100.50',
	issueDate: '2026-10-14',
}

@Plugin()
class Consumer extends BasePlugin {
	constructor(private readonly fiscal: InvoicePlugin) {
		super()
	}
	verify(input: FiscalTicketInput = ticket, options: InvoiceOptions = {}) {
		return this.fiscal.verify({ kind: 'fiscal', ticket: input }, options)
	}
}

async function setup(initialConfig: { timeoutMs?: number; maxConcurrent?: number } = {}) {
	const browser = new BrowserFixture()
	vi.spyOn(chromium, 'connectOverCDP').mockResolvedValue(browser.asBrowser())
	const host = await createTestHost()
	try {
		await host.commit((change) => {
			change.catalog.add([PlaywrightPlugin, InvoicePlugin, Consumer])
			change.start(PlaywrightPlugin, { initialConfig: { endpoint: 'http://127.0.0.1:9222' } })
			change.start(InvoicePlugin, { initialConfig })
			change.start(Consumer)
		})
		return { host, browser, consumer: host.require(Consumer) }
	} catch (error) {
		await host.dispose()
		throw error
	}
}

afterEach(() => {
	vi.restoreAllMocks()
})

describe('InvoicePlugin through real host and DOM-backed external browser fixture', () => {
	it.each([0, 1, 2])(
		'fills the observed desktop form and reads hidden duplicate-ID template %i',
		async (template) => {
			const { host, browser, consumer } = await setup()
			await using _owned = host
			browser.onSubmit = (context) => {
				context.result({ ...ticket, amount: '0100.5' }, template)
				const target = context.document.querySelectorAll('.bill-content')[template]
				target.insertAdjacentHTML(
					'beforeend',
					'<p><label>交款人：</label>测试单位</p><div>财政附加信息</div>',
				)
			}
			const result = await consumer.verify()
			expect(result).toMatchObject({
				status: 'matched',
				details: {
					kind: 'fiscal',
					...ticket,
					amount: '0100.5',
					payer: { name: '测试单位', taxId: null },
				},
				evidence: {
					source: 'official-portal',
					truncated: false,
					fields: expect.arrayContaining([{ section: '', label: '交款人：', value: '测试单位' }]),
					text: expect.stringContaining('财政附加信息'),
				},
			})
			const context = browser.contexts[0]
			expect(context.page.goto).toHaveBeenCalledWith(
				'https://pjcy.mof.gov.cn/html/index.html#/home',
				{ waitUntil: 'domcontentloaded' },
			)
			expect(Object.fromEntries(context.fills)).toEqual({
				'input[maxlength="8"]': ticket.code,
				'input[maxlength="10"]': ticket.number,
				'input[maxlength="6"]': ticket.checkCode,
				':scope > div:nth-child(4) input': ticket.amount,
				'.datePicker input': ticket.issueDate,
			})
			expect(context.closed).toBe(true)
			expect(browser.close).not.toHaveBeenCalled()
		},
	)

	it.each([
		{ code: '123' },
		{ number: '123' },
		{ checkCode: '非ASCII' },
		{ amount: '1.234' },
		{ issueDate: '2026-02-30' },
		{ amount: 'NaN' },
	])('rejects invalid fields before acquiring a context: %j', async (invalid) => {
		const { host, browser, consumer } = await setup()
		await using _owned = host
		await expect(consumer.verify({ ...ticket, ...invalid })).rejects.toBeInstanceOf(TypeError)
		expect(browser.newContext).not.toHaveBeenCalled()
	})

	it('allows negative credit amounts and snapshots input before awaiting', async () => {
		const { host, browser, consumer } = await setup()
		await using _owned = host
		const input = { ...ticket, amount: '-10.5' }
		browser.onSubmit = (context) => context.result({ ...ticket, amount: '-10.50' })
		const result = consumer.verify(input)
		input.amount = '999'
		expect(await result).toMatchObject({ status: 'matched' })
	})

	it.each([
		{ number: '9999999999' },
		{ code: '99999999' },
		{ checkCode: 'zzzzzz' },
		{ amount: '100.51' },
		{ issueDate: '2026-10-13' },
	])('does not confirm a mismatched ticket field: %j', async (changed) => {
		const { host, browser, consumer } = await setup()
		await using _owned = host
		browser.onSubmit = (context) => context.result({ ...ticket, ...changed })
		expect(await consumer.verify()).toEqual({ status: 'unconfirmed', reason: 'identity_mismatch' })
	})

	it('requires human interaction without misclassifying the challenge as a failed ticket', async () => {
		const { host, browser, consumer } = await setup()
		await using _owned = host
		browser.onSubmit = (context) => context.challenge()
		expect(await consumer.verify()).toEqual({
			status: 'action_required',
			challenge: 'security_verification',
		})
		expect(browser.contexts[0].closed).toBe(true)
	})

	it('lends the original page to one challenge callback and resumes result observation', async () => {
		const { host, browser, consumer } = await setup()
		await using _owned = host
		browser.onSubmit = (context) => context.challenge()
		const onChallenge = vi.fn(async ({ page, signal }) => {
			expect(page).toBe(browser.contexts[0].page)
			expect(signal.aborted).toBe(false)
			browser.contexts[0].result(ticket)
		})
		expect(await consumer.verify(ticket, { onChallenge })).toMatchObject({ status: 'matched' })
		expect(onChallenge).toHaveBeenCalledTimes(1)
	})

	it('allows website processing to complete after the human callback returns', async () => {
		const { host, browser, consumer } = await setup()
		await using _owned = host
		browser.onSubmit = (context) => context.challenge()
		const onChallenge = vi.fn(async () => {
			setTimeout(() => browser.contexts[0].result(ticket), 20)
		})
		expect(await consumer.verify(ticket, { onChallenge })).toMatchObject({ status: 'matched' })
		expect(onChallenge).toHaveBeenCalledTimes(1)
	})

	it('does not confirm ambiguous or malformed central templates', async () => {
		const { host, browser, consumer } = await setup()
		await using _owned = host
		browser.onSubmit = (context) => {
			context.result(ticket, 0)
			context.result(ticket, 1)
		}
		expect(await consumer.verify()).toEqual({ status: 'unconfirmed', reason: 'unsupported_result' })
		browser.onSubmit = (context) => context.result({ ...ticket, amount: 'unavailable' })
		expect(await consumer.verify()).toEqual({ status: 'unconfirmed', reason: 'unsupported_result' })
	})

	it('honors pre-aborted calls before acquiring any page', async () => {
		const { host, browser, consumer } = await setup()
		await using _owned = host
		const reason = new Error('Already cancelled')
		await expect(consumer.verify(ticket, { signal: AbortSignal.abort(reason) })).rejects.toBe(
			reason,
		)
		expect(browser.newContext).not.toHaveBeenCalled()
	})

	it('returns site text without turning a remote error into a false or nonexistent ticket', async () => {
		const { host, browser, consumer } = await setup()
		await using _owned = host
		browser.onSubmit = (context) => context.message('票据不存在，请您核对后再次查验。')
		expect(await consumer.verify()).toEqual({
			status: 'unconfirmed',
			reason: 'site_message',
			message: '票据不存在，请您核对后再次查验。',
		})
	})

	it('does not treat a local-government iframe or empty identity as verified', async () => {
		const { host, browser, consumer } = await setup()
		await using _owned = host
		browser.onSubmit = (context) => {
			context.document.querySelector('.wrapper_billshow')!.removeAttribute('style')
			context.document.body.insertAdjacentHTML(
				'beforeend',
				'<iframe sandbox id="Ateon-SetParent-iframe"></iframe>',
			)
		}
		expect(await consumer.verify()).toEqual({ status: 'unconfirmed', reason: 'unsupported_result' })
	})

	it('preserves unexpected SDK and callback exceptions and closes contexts', async () => {
		const { host, browser, consumer } = await setup()
		await using _owned = host
		const sdkError = new Error('SDK broke')
		browser.onSubmit = () => {
			throw sdkError
		}
		await expect(consumer.verify()).rejects.toBe(sdkError)
		expect(browser.contexts[0].closed).toBe(true)
		const callbackError = new Error('Human UI failed')
		browser.onSubmit = (context) => context.challenge()
		await expect(
			consumer.verify(ticket, {
				onChallenge: async () => {
					throw callbackError
				},
			}),
		).rejects.toBe(callbackError)
		expect(browser.contexts[1].closed).toBe(true)
	})

	it('aborts an outstanding challenge, closes its page and rejects excess calls without queuing', async () => {
		const { host, browser, consumer } = await setup()
		await using _owned = host
		browser.onSubmit = (context) => context.challenge()
		const controller = new AbortController()
		const entered = Promise.withResolvers<void>()
		const pending = consumer.verify(ticket, {
			signal: controller.signal,
			onChallenge: async () => {
				entered.resolve()
				await new Promise(() => {})
			},
		})
		await entered.promise
		await expect(consumer.verify()).rejects.toMatchObject({ code: 'BUSY' })
		await expect(
			host.require(InvoicePlugin).verify({
				kind: 'digital-tax',
				number: '12345678901234567890',
				issueDate: '2026-10-14',
				totalIncludingTax: '100.50',
			}),
		).rejects.toMatchObject({ code: 'BUSY' })
		const reason = new Error('Requested cancellation')
		// Attach the expected rejection before triggering cancellation.
		const outcome = pending.then(
			(value) => ({ value }),
			(error: unknown) => ({ error }),
		)
		controller.abort(reason)
		expect(await outcome).toEqual({ error: reason })
		expect(browser.contexts[0].closed).toBe(true)
		browser.onSubmit = (context) => context.result(ticket)
		expect(await consumer.verify()).toMatchObject({ status: 'matched' })
	})

	it('bounds waiting for a callback that ignores its abort signal', async () => {
		const { host, browser, consumer } = await setup({ timeoutMs: 1000 })
		await using _owned = host
		browser.onSubmit = (context) => context.challenge()
		await expect(
			consumer.verify(ticket, {
				onChallenge: async () => {
					await new Promise(() => {})
				},
			}),
		).rejects.toMatchObject({ code: 'TIMEOUT' })
		expect(browser.contexts[0].closed).toBe(true)
	})

	it.each([Consumer, InvoicePlugin])(
		'drains an accepted call when its owner/provider stops',
		async (stopped) => {
			const { host, browser, consumer } = await setup()
			await using _owned = host
			browser.onSubmit = (context) => context.challenge()
			const entered = Promise.withResolvers<void>()
			const pending = consumer.verify(ticket, {
				onChallenge: async () => {
					entered.resolve()
					await new Promise(() => {})
				},
			})
			const outcome = pending.then(
				(value) => ({ value }),
				(error: unknown) => ({ error }),
			)
			await entered.promise
			await host.stop(stopped)
			expect(await outcome).toMatchObject({ error: { code: 'NOT_RUNNING' } })
			expect(browser.contexts[0].closed).toBe(true)
		},
	)
})

it('rejects duplicate identity fields inside a populated fiscal record', async () => {
	const { host, browser, consumer } = await setup()
	await using _owned = host
	browser.onSubmit = (context) => {
		context.result(ticket)
		const target = context.document.querySelectorAll('.bill-content')[1]
		target.insertAdjacentHTML('beforeend', '<span id="EInvoiceCode">12345678</span>')
	}
	expect(await consumer.verify()).toEqual({ status: 'unconfirmed', reason: 'unsupported_result' })
})
