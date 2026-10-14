import { afterEach, expect, it, vi } from 'vitest'
import * as v from 'valibot'
import { InvoiceConfig, InvoicePlugin } from '@pluxel/invoice'
import { candidate, Consumer, image, invoice, response, settings, setup } from './setup.ts'
import { InvoiceConsumer } from '../examples/consumer.ts'
import application from '../examples/application.ts'
import { resolveHostApplication } from '@pluxel/host'

afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
})

it('resolves the production example Vault binding and executes its review branch', async () => {
	const resolved = await resolveHostApplication(application, {
		root: process.cwd(),
		mode: 'test',
		bindings: {},
		env: {
			BROWSER_ENDPOINT: 'http://127.0.0.1:9222',
			INVOICE_VLM_ENDPOINT: settings.endpoint,
			INVOICE_VLM_MODEL: settings.model,
			INVOICE_VLM_KEY: 'example-key',
		},
	})
	expect(resolved.vaultBindings).toHaveLength(1)
	expect(resolved.vaultBindings?.[0]).toMatchObject({
		key: 'primary',
		value: { apiKey: 'example-key' },
	})
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => response({ kind: 'unsupported' })),
	)
	const { host } = await setup()
	await using _owned = host
	const consumer = await host.start(InvoiceConsumer)
	expect(await consumer.check(image)).toMatchObject({
		state: 'review',
		result: { status: 'needs_review', fields: ['kind'] },
	})
})

it('extracts through a real host, Vault and caller without acquiring a browser', async () => {
	const fetch = vi.fn(async () => response())
	vi.stubGlobal('fetch', fetch)
	const { host, consumer, newContext } = await setup()
	await using _owned = host
	expect(await consumer.extract()).toMatchObject({
		status: 'extracted',
		input: invoice,
		details: {
			kind: 'digital-tax',
			amounts: { totalExcludingTax: '100.00', taxAmount: '13.00', totalIncludingTax: '113.00' },
			buyer: null,
			items: null,
		},
	})
	expect(newContext).not.toHaveBeenCalled()
	const [, request] = fetch.mock.calls[0] as unknown as [string, RequestInit]
	expect(request.headers).toMatchObject({ Authorization: 'Bearer test-secret' })
	expect(request.redirect).toBe('error')
	expect(JSON.parse(request.body as string)).toMatchObject({ model: 'vision', max_tokens: 4096 })
})

it.each([
	{ number: '1234567890123456789' },
	{ issueDate: '2026-02-30' },
	{ totalIncludingTax: '¥113.00' },
	{ taxAmount: '12.00' },
	{ number: null },
])('stops invalid extraction before website submission: %j', async (change) => {
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => response({ ...candidate, ...change })),
	)
	const { host, consumer, newContext } = await setup()
	await using _owned = host
	expect(await consumer.verifyImage()).toMatchObject({
		status: 'needs_review',
		reason: 'invalid_fields',
	})
	expect(newContext).not.toHaveBeenCalled()
})

it('keeps unsupported invoice types for review rather than guessing a platform', async () => {
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => response({ kind: 'unsupported', number: '12345678' })),
	)
	const { host, consumer } = await setup()
	await using _owned = host
	expect(await consumer.extract()).toMatchObject({
		status: 'needs_review',
		reason: 'unsupported_document',
	})
})

it('extracts fiscal fields without converting their printed check code to a CAPTCHA', async () => {
	const ticket = {
		code: '00123456',
		number: '0012345678',
		checkCode: 'Aa1234',
		amount: '100.00',
		issueDate: '2026-07-17',
	}
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => response({ kind: 'fiscal', ...ticket })),
	)
	const { host, consumer } = await setup()
	await using _owned = host
	expect(await consumer.extract()).toMatchObject({
		status: 'extracted',
		input: { kind: 'fiscal', ticket },
	})
})

it.each(['length', 'tool_calls'])('rejects incomplete/model-tool responses: %s', async (finish) => {
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => response(candidate, finish)),
	)
	const { host, consumer } = await setup()
	await using _owned = host
	await expect(consumer.extract()).rejects.toMatchObject({ code: 'VLM_RESPONSE' })
})

it.each(['{} trailing prose', '{"number":123}', '```json\n{"kind":"unsupported"}\n``` trailing'])(
	'rejects malformed model contracts without leaking response text',
	async (content) => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				Response.json({ choices: [{ finish_reason: 'stop', message: { content } }] }),
			),
		)
		const { host, consumer } = await setup()
		await using _owned = host
		await expect(consumer.extract()).rejects.toMatchObject({ code: 'VLM_RESPONSE' })
	},
)

it('accepts a whole JSON fence and bounds HTTP diagnostics', async () => {
	const fetch = vi
		.fn()
		.mockResolvedValueOnce(
			Response.json({
				choices: [
					{
						finish_reason: 'stop',
						message: { content: '```json\n' + JSON.stringify(candidate) + '\n```' },
					},
				],
			}),
		)
		.mockResolvedValueOnce(new Response('secret provider diagnostic', { status: 401 }))
	vi.stubGlobal('fetch', fetch)
	const { host, consumer } = await setup()
	await using _owned = host
	expect(await consumer.extract()).toMatchObject({ status: 'extracted' })
	await expect(consumer.extract()).rejects.toMatchObject({
		code: 'VLM_HTTP',
		httpStatus: 401,
		message: 'Invoice model request failed',
	})
})

it('rejects oversized model bodies', async () => {
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => new Response('x'.repeat(1024 * 1024 + 1))),
	)
	const { host, consumer } = await setup()
	await using _owned = host
	await expect(consumer.extract()).rejects.toMatchObject({ code: 'VLM_RESPONSE' })
})

it('requires explicit VLM configuration only for recognition', async () => {
	const { host, consumer } = await setup({})
	await using _owned = host
	await expect(consumer.extract()).rejects.toMatchObject({ code: 'VLM_NOT_CONFIGURED' })
	await expect(consumer.verify({ ...invoice, number: 'bad' })).rejects.toBeInstanceOf(TypeError)
})

it.each([Consumer, InvoicePlugin])(
	'cancels pending model IO when caller/provider stops and enforces admission',
	async (owner) => {
		const entered = Promise.withResolvers<void>()
		vi.stubGlobal(
			'fetch',
			vi.fn(
				(_url, init) =>
					new Promise((_resolve, reject) => {
						entered.resolve()
						init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
					}),
			),
		)
		const { host, consumer } = await setup()
		await using _owned = host
		const pending = consumer.extract().catch((error: unknown) => error)
		await entered.promise
		await expect(consumer.extract()).rejects.toMatchObject({ code: 'BUSY' })
		await host.stop(owner)
		expect(await pending).toMatchObject({ code: 'NOT_RUNNING' })
	},
)

it('enforces total recognition timeout and caller cancellation', async () => {
	vi.stubGlobal(
		'fetch',
		vi.fn(
			(_url, init) =>
				new Promise((_resolve, reject) => {
					init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
				}),
		),
	)
	const { host, consumer } = await setup({ vlm: settings, timeoutMs: 1000 })
	await using _owned = host
	await expect(consumer.extract()).rejects.toMatchObject({ code: 'TIMEOUT' })
	const reason = new Error('cancelled')
	await expect(consumer.extract(image, { signal: AbortSignal.abort(reason) })).rejects.toBe(reason)
})

it('rejects secret-bearing endpoints and invalid image signatures before IO', async () => {
	for (const endpoint of [
		'http://model.invalid/chat',
		'https://model.invalid/chat?key=secret',
		'https://user:secret@model.invalid/chat',
	])
		expect(v.safeParse(InvoiceConfig, { vlm: { ...settings, endpoint } }).success).toBe(false)
	const { host, consumer } = await setup()
	await using _owned = host
	await expect(
		consumer.extract({ ...image, bytes: new Uint8Array([1, 2]) }),
	).rejects.toBeInstanceOf(TypeError)
})
