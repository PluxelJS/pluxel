import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { chromium } from 'playwright-core'
import { expect, it, vi } from 'vitest'
import { settings, setup } from './setup.ts'

it('records model extraction and official portal observations for explicitly supplied local images', async () => {
	const { INVOICE_VLM_KEY, INVOICE_VLM_ENDPOINT, INVOICE_VLM_MODEL, INVOICE_IMAGES } = process.env
	if (!INVOICE_VLM_KEY || !INVOICE_VLM_ENDPOINT || !INVOICE_VLM_MODEL || !INVOICE_IMAGES)
		throw new Error(
			'Set INVOICE_VLM_KEY, INVOICE_VLM_ENDPOINT, INVOICE_VLM_MODEL and INVOICE_IMAGES (JSON absolute JPEG paths)',
		)
	const files: unknown = JSON.parse(INVOICE_IMAGES)
	if (
		!Array.isArray(files) ||
		files.length === 0 ||
		files.length > 3 ||
		!files.every((path) => typeof path === 'string')
	)
		throw new TypeError('INVOICE_IMAGES must contain one to three JPEG paths')
	const browser = await chromium.launch({ headless: true })
	try {
		if (process.env.INVOICE_CAPTURE_DIR) {
			const directory = process.env.INVOICE_CAPTURE_DIR
			await mkdir(directory, { recursive: true })
			const newContext = browser.newContext.bind(browser)
			let sequence = 0
			vi.spyOn(browser, 'newContext').mockImplementation(async (options) => {
				const context = await newContext(options)
				const close = context.close.bind(context)
				const prefix = join(directory, `invoice-${++sequence}`)
				let captured = false
				vi.spyOn(context, 'close').mockImplementation(async (closeOptions) => {
					try {
						const page = context.pages()[0]
						if (!captured && page && !page.isClosed()) {
							captured = true
							await writeFile(`${prefix}.html`, await page.content())
							await page.screenshot({ path: `${prefix}.png`, timeout: 5000 })
						}
					} finally {
						await close(closeOptions)
					}
				})
				return context
			})
		}
		const { host, consumer } = await setup(
			{
				vlm: { ...settings, endpoint: INVOICE_VLM_ENDPOINT, model: INVOICE_VLM_MODEL },
				captchaAttempts: Number(process.env.INVOICE_CAPTCHA_ATTEMPTS ?? 1),
			},
			browser,
			INVOICE_VLM_KEY,
		)
		await using _owned = host
		for (const file of files) {
			const result = await consumer.verifyImage({
				bytes: await readFile(file),
				mimeType: 'image/jpeg',
			})
			// Never print numbers, image data, credentials, model reasoning or raw website text.
			const observation = JSON.stringify({
				file: basename(file),
				source: 'live',
				model: INVOICE_VLM_MODEL,
				humanChallengeHandler: false,
				status: result.status,
				...(result.status === 'completed'
					? {
							kind: result.extraction.input.kind,
							verification: result.verification.status,
							...('redLetterStatus' in result.verification
								? { redLetterStatus: result.verification.redLetterStatus }
								: {}),
							...('reason' in result.verification ? { reason: result.verification.reason } : {}),
						}
					: { reason: result.reason, fields: result.fields }),
			})
			console.log(observation)
			if (process.env.INVOICE_REPORT)
				await appendFile(process.env.INVOICE_REPORT, observation + '\n')
			expect(result.status).toBe('completed')
		}
	} finally {
		vi.restoreAllMocks()
		await browser.close()
	}
})
