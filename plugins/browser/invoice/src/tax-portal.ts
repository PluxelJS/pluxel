import { setTimeout as delay } from 'node:timers/promises'
import type { Page } from 'playwright-core'
import type {
	InvoiceImage,
	InvoiceInput,
	InvoiceOptions,
	InvoiceVerification,
} from './contracts.ts'
import { cents } from './values.ts'
import { normalizeDetails } from './details.ts'
import { readPortalRecords, type PortalRecord } from './portal-snapshot.ts'

export const TAX_PORTAL_URL = 'https://inv-veri.chinatax.gov.cn/fpcygzfw/national-invoice-check'
type TaxInput = Extract<InvoiceInput, { kind: 'digital-tax' }>
type Solver = (image: InvoiceImage, instruction: string) => Promise<string | null>

/** Use the readonly calendar's normal controls; never mutate the site's Vue state. */
async function selectDate(page: Page, value: string, signal: AbortSignal) {
	await page.locator('.t-form-item__kprq input').click()
	const panel = page.locator('.t-date-picker__panel:visible')
	const year = Number(
		await panel.locator('.t-date-picker__header-controller-year input').inputValue(),
	)
	const month = parseInt(
		await panel.locator('.t-date-picker__header-controller-month input').inputValue(),
		10,
	)
	const [targetYear, targetMonth, day] = value.split('-').map(Number)
	const delta = (year - targetYear) * 12 + month - targetMonth
	if (!Number.isInteger(delta) || month < 1 || month > 12 || Math.abs(delta) > 72)
		throw new TypeError('Invoice date is outside the supported portal calendar range')
	for (let index = 0; index < Math.abs(delta); index++) {
		signal.throwIfAborted()
		await panel.getByTitle(delta > 0 ? '上个月' : '下个月', { exact: true }).click()
	}
	await panel
		.locator('.t-date-picker__cell:not(.t-date-picker__cell--additional)')
		.filter({ hasText: new RegExp(`^${day}$`) })
		.click()
	if ((await page.locator('.t-form-item__kprq input').inputValue()) !== value.replaceAll('-', ''))
		throw new Error('Tax portal did not accept the requested calendar date')
}

async function message(page: Page): Promise<string> {
	const messages = await page.locator('.t-message:visible, .t-dialog:visible').allTextContents()
	return messages
		.map((value) => value.trim())
		.filter(Boolean)
		.join('\n')
		.slice(0, 4096)
}

/** Parse only the observed invoice detail container, never the form or a generic dialog. */
export function readTaxResult(
	records: PortalRecord[],
	input: TaxInput,
): InvoiceVerification | undefined {
	if (records.length === 0) return undefined
	if (records.length !== 1) return { status: 'unconfirmed', reason: 'unsupported_result' }
	const record = records[0]
	const numbers = record.identity.number
	const dates = record.identity.issueDate
	if (numbers.length !== 1 || dates.length !== 1 || record.identity.amount.length !== 1)
		return { status: 'unconfirmed', reason: 'unsupported_result' }
	const number = /^发票号码\s*[：:]\s*(\d{20})$/.exec(numbers[0])?.[1]
	const date = /^开票日期\s*[：:]\s*(\d{4})年(\d{1,2})月(\d{1,2})日$/.exec(dates[0])
	const amount = /^[（(]小写[）)]\s*[¥￥]?\s*(-?\d{1,16}(?:\.\d{1,2})?)$/.exec(
		record.identity.amount[0],
	)?.[1]
	if (!number || !date || !amount) return { status: 'unconfirmed', reason: 'unsupported_result' }
	const issueDate = `${date[1]}-${date[2].padStart(2, '0')}-${date[3].padStart(2, '0')}`
	if (
		number !== input.number ||
		issueDate !== input.issueDate ||
		cents(amount) !== cents(input.totalIncludingTax)
	)
		return { status: 'unconfirmed', reason: 'identity_mismatch' }
	// This exact official asset was visually confirmed as 全额红冲 in the live result.
	const fullyReversed = record.marks.some((src) =>
		/^\/fpcygzfw\/assets_res\/img\/icon_qehc_new\.[\w-]+\.png$/.test(src),
	)
	return {
		status: 'matched',
		...normalizeDetails(
			{ ...input, number, issueDate, totalIncludingTax: amount },
			record.evidence,
		),
		evidence: record.evidence,
		checkedAt: new Date().toISOString(),
		redLetterStatus: fullyReversed ? 'fully_reversed' : 'not_observed',
	}
}

export async function readTaxRecords(page: Page): Promise<PortalRecord[]> {
	return await page
		.locator('.invoice-dialog #invoice-elm:visible')
		.evaluateAll(readPortalRecords, 'digital-tax' as const)
}

export async function queryTaxPortal(
	page: Page,
	input: TaxInput,
	signal: AbortSignal,
	attempts: number,
	solve: Solver | undefined,
	{ onChallenge, onCaptcha }: Pick<InvoiceOptions, 'onChallenge' | 'onCaptcha'>,
): Promise<InvoiceVerification> {
	await page.goto(TAX_PORTAL_URL, { waitUntil: 'domcontentloaded' })
	await page.locator('.t-form-item__fphm input').fill(input.number)
	await page.locator('.t-form-item__fphm input').press('Tab')
	// The site changes this label after classifying the number. Fail closed on a changed contract.
	await page
		.locator('.t-form-item__kpje label')
		.filter({ hasText: '价税合计' })
		.waitFor({ state: 'visible' })
	await selectDate(page, input.issueDate, signal)
	await page.locator('.t-form-item__kpje input').fill(input.totalIncludingTax)
	await page.locator('.t-form-item__kpje input').press('Tab')
	const captcha = page.locator('form img[width="120"]')
	let submitted = false
	let automatic = 0
	let human = false
	for (;;) {
		signal.throwIfAborted()
		const result = readTaxResult(await readTaxRecords(page), input)
		if (result) return result
		const notice = await message(page)
		if (notice) {
			const rejectedCaptcha =
				submitted && !human && /^(验证码错误|验证码不正确)[！!。.]?$/.test(notice)
			if (rejectedCaptcha && ((automatic < attempts && solve) || (onCaptcha && !human))) {
				// Only this explicit rejection authorizes another submission. No timeout/network retries.
				await page.locator('.t-message:visible, .t-dialog:visible').waitFor({ state: 'hidden' })
				submitted = false
			} else if (rejectedCaptcha && onChallenge) {
				await page.locator('.t-message:visible, .t-dialog:visible').waitFor({ state: 'hidden' })
				human = true
				await onChallenge({ page, signal })
				continue
			} else return { status: 'unconfirmed', reason: 'site_message', message: notice }
		}
		if (!submitted) {
			if ((solve && automatic < attempts) || (onCaptcha && !human)) {
				const previousSrc = await captcha.getAttribute('src')
				await captcha.click()
				for (;;) {
					signal.throwIfAborted()
					const captchaNotice = await message(page)
					if (captchaNotice)
						return { status: 'unconfirmed', reason: 'site_message', message: captchaNotice }
					if (
						await captcha.evaluate(
							(img, previous) =>
								img instanceof HTMLImageElement &&
								img.complete &&
								img.naturalWidth > 0 &&
								img.getAttribute('src') !== previous &&
								!img.src.includes('/assets_res/img/code.'),
							previousSrc,
						)
					)
						break
					await delay(150, undefined, { signal })
				}
				const instructionText = await page.locator('.form-box-tip__yzm').innerText()
				const instruction = instructionText.slice(0, 512)
				const src = await captcha.getAttribute('src')
				const image: InvoiceImage = { bytes: await captcha.screenshot(), mimeType: 'image/png' }
				const current = async () =>
					(await captcha.getAttribute('src')) === src &&
					(await page.locator('.form-box-tip__yzm').innerText()) === instructionText
				let answer = solve && automatic < attempts ? await solve(image, instruction) : null
				signal.throwIfAborted()
				if (!answer && onCaptcha && !human && (await current())) {
					human = true
					answer = await onCaptcha({ image, instruction, signal })
					if (
						answer !== null &&
						(typeof answer !== 'string' || !/^[\p{L}\p{N}]{1,8}$/u.test(answer))
					)
						throw new TypeError('CAPTCHA answer must be one to eight letters/digits or null')
				}
				signal.throwIfAborted()
				if (answer && (await current())) {
					await page.locator('.t-form-item__yzm input').fill(answer)
					if (!(await current()))
						return { status: 'action_required', challenge: 'security_verification' }
					await page.getByRole('button', { name: '查 验', exact: true }).click()
					if (!human) automatic++
					submitted = true
					continue
				}
			}
			if (!onChallenge || human)
				return { status: 'action_required', challenge: 'security_verification' }
			human = true
			await onChallenge({ page, signal })
			submitted = true
		}
		await delay(150, undefined, { signal })
	}
}
