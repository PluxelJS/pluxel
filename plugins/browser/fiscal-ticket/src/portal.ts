import { setTimeout as delay } from 'node:timers/promises'
import type { Page } from 'playwright-core'
import type {
	FiscalTicketInput,
	FiscalTicketResult,
	FiscalTicketVerifyOptions,
} from './contracts.ts'

export const PORTAL_URL = 'https://pjcy.mof.gov.cn/html/index.html#/home'

/** Public site DOM observed in app.7fd3f2ee.js, 2026-10-14. See DESIGN.md. */
export async function queryPortal(
	page: Page,
	input: FiscalTicketInput,
	signal: AbortSignal,
	onChallenge: FiscalTicketVerifyOptions['onChallenge'],
): Promise<FiscalTicketResult> {
	await page.goto(PORTAL_URL, { waitUntil: 'domcontentloaded' })
	const form = page.locator('form#idform')
	await form.locator('input[maxlength="8"]').fill(input.code)
	await form.locator('input[maxlength="10"]').fill(input.number)
	await form.locator('input[maxlength="6"]').fill(input.checkCode)
	await form.locator(':scope > div:nth-child(4) input').fill(input.amount)
	await form.locator('.datePicker input').fill(input.issueDate)
	await form.locator('.datePicker input').press('Tab')
	signal.throwIfAborted()
	await page.locator('.findbtn').click()
	let challenged = false
	for (;;) {
		signal.throwIfAborted()
		if (await page.locator('.wrapper_billshow').isVisible()) {
			// v-show leaves all three templates in DOM, with duplicate IDs. The site
			// hides populated source markup after converting it to a canvas image.
			const candidates = await page
				.locator('.wrapper_billshow .bill-content')
				.evaluateAll((elements) =>
					elements.map((element) => {
						const text = (selector: string) =>
							element.querySelector(selector)?.textContent?.trim() ?? ''
						const amounts = element.querySelectorAll('td.nobd-l.td2 > span.font-val')
						return {
							code: text('#EInvoiceCode'),
							number: text('#EInvoiceNumber'),
							checkCode: text('#RandomNumber'),
							issueDate: text('#IssueDate'),
							amount: amounts.length === 1 ? (amounts[0].textContent?.trim() ?? '') : '',
						}
					}),
				)
			const populated = candidates.filter(
				(ticket) => ticket.code || ticket.number || ticket.checkCode,
			)
			if (populated.length > 0) {
				if (populated.length !== 1 || !readable(populated[0])) {
					return { status: 'unconfirmed', reason: 'unsupported_result' }
				}
				const ticket = populated[0]
				if (
					ticket.code !== input.code ||
					ticket.number !== input.number ||
					ticket.checkCode !== input.checkCode ||
					ticket.issueDate !== input.issueDate ||
					cents(ticket.amount) !== cents(input.amount)
				)
					return { status: 'unconfirmed', reason: 'identity_mismatch' }
				return { status: 'matched', ticket: { ...ticket }, checkedAt: new Date().toISOString() }
			}
			if ((await page.locator('#Ateon-SetParent-iframe').count()) > 0) {
				return { status: 'unconfirmed', reason: 'unsupported_result' }
			}
		}
		const messages = await page
			.locator(
				'.el-message:visible .el-message__content, .el-message-box:visible .el-message-box__message',
			)
			.allTextContents()
		const message = messages
			.map((text) => text.trim())
			.filter(Boolean)
			.join('\n')
			.slice(0, 4096)
		if (message) return { status: 'unconfirmed', reason: 'site_message', message }
		if (await page.locator('.diaVerify').isVisible()) {
			if (!onChallenge) return { status: 'action_required', challenge: 'security_verification' }
			if (!challenged) {
				challenged = true
				await abortable(
					Promise.resolve().then(() => onChallenge({ page, signal })),
					signal,
				)
				continue
			}
		}
		await delay(150, undefined, { signal })
	}
}

function readable(ticket: FiscalTicketInput): boolean {
	return (
		/^\d{8}$/.test(ticket.code) &&
		/^\d{10}$/.test(ticket.number) &&
		/^[A-Za-z0-9]{6}$/.test(ticket.checkCode) &&
		/^\d{4}-\d{2}-\d{2}$/.test(ticket.issueDate) &&
		/^-?\d{1,16}(?:\.\d{1,2})?$/.test(ticket.amount)
	)
}

function cents(amount: string): bigint {
	const negative = amount.startsWith('-')
	const [whole, fraction = ''] = (negative ? amount.slice(1) : amount).split('.')
	return (BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'))) * (negative ? -1n : 1n)
}

/** Stops waiting, while observing late rejection. The callback must stop its own external IO. */
export async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	let abort: () => void = () => {}
	const stopped = new Promise<never>((_resolve, reject) => {
		abort = () => reject(signal.reason)
		if (signal.aborted) abort()
		else signal.addEventListener('abort', abort, { once: true })
	})
	try {
		return await Promise.race([work, stopped])
	} finally {
		signal.removeEventListener('abort', abort)
	}
}
