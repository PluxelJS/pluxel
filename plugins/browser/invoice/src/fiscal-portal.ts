import { cents } from './values.ts'
import { normalizeDetails } from './details.ts'
import { readPortalRecords } from './portal-snapshot.ts'
import { abortable } from './operation.ts'
import { setTimeout as delay } from 'node:timers/promises'
import type { Page } from 'playwright-core'
import type { FiscalTicketInput, InvoiceVerification, InvoiceOptions } from './contracts.ts'

const PORTAL_URL = 'https://pjcy.mof.gov.cn/html/index.html#/home'

/** Public site DOM observed in app.7fd3f2ee.js, 2026-10-14. See DESIGN.md. */
export async function queryFiscalPortal(
	page: Page,
	input: FiscalTicketInput,
	signal: AbortSignal,
	onChallenge: InvoiceOptions['onChallenge'],
): Promise<InvoiceVerification> {
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
				.evaluateAll(readPortalRecords, 'fiscal' as const)
			const populated = candidates.filter(({ identity }) =>
				[...identity.code, ...identity.number, ...identity.checkCode].some(
					(value) => value.length > 0,
				),
			)
			if (populated.length > 0) {
				if (populated.length !== 1) return { status: 'unconfirmed', reason: 'unsupported_result' }
				const { identity, evidence } = populated[0]
				if (Object.values(identity).some((values) => values.length !== 1))
					return { status: 'unconfirmed', reason: 'unsupported_result' }
				const ticket: FiscalTicketInput = {
					code: identity.code[0],
					number: identity.number[0],
					checkCode: identity.checkCode[0],
					issueDate: identity.issueDate[0],
					amount: identity.amount[0],
				}
				if (!readable(ticket)) return { status: 'unconfirmed', reason: 'unsupported_result' }
				if (
					ticket.code !== input.code ||
					ticket.number !== input.number ||
					ticket.checkCode !== input.checkCode ||
					ticket.issueDate !== input.issueDate ||
					cents(ticket.amount) !== cents(input.amount)
				)
					return { status: 'unconfirmed', reason: 'identity_mismatch' }
				return {
					status: 'matched',
					...normalizeDetails({ kind: 'fiscal', ticket }, evidence),
					evidence,
					checkedAt: new Date().toISOString(),
					redLetterStatus: 'not_observed',
				}
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
