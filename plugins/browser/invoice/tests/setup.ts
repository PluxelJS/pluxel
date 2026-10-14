import { EventEmitter } from 'node:events'
import { BasePlugin, Plugin, pluginNodeAddressOf } from '@pluxel/core'
import { HostVaultBindings } from '@pluxel/host/bindings'
import { defineHostService } from '@pluxel/host'
import { PlaywrightPlugin } from '@pluxel/playwright'
import { vault, Vault } from '@pluxel/services/vault'
import { createTestHost } from '@pluxel/test'
import { chromium, type Browser } from 'playwright-core'
import { vi } from 'vitest'
import {
	InvoicePlugin,
	type InvoiceImage,
	type InvoiceInput,
	type InvoiceOptions,
} from '@pluxel/invoice'

export const settings = {
	endpoint: 'https://model.invalid/v1/chat/completions',
	model: 'vision',
	credentialKey: 'primary',
	maxOutputTokens: 4096,
}
export const candidate = {
	kind: 'digital-tax',
	number: '12345678901234567890',
	issueDate: '2026-07-17',
	totalExcludingTax: '100.00',
	taxAmount: '13.00',
	totalIncludingTax: '113.00',
}
export const invoice: Extract<InvoiceInput, { kind: 'digital-tax' }> = {
	kind: 'digital-tax',
	number: candidate.number,
	issueDate: candidate.issueDate,
	totalIncludingTax: candidate.totalIncludingTax,
}
export const image: InvoiceImage = {
	bytes: Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]),
	mimeType: 'image/jpeg',
}
export function response(value: unknown = candidate, finish = 'stop') {
	return Response.json({
		choices: [{ finish_reason: finish, message: { content: JSON.stringify(value) } }],
	})
}

@Plugin()
export class Consumer extends BasePlugin {
	constructor(private readonly invoices: InvoicePlugin) {
		super()
	}
	extract(input = image, options: InvoiceOptions = {}) {
		return this.invoices.extract(input, options)
	}
	verifyImage(input = image, options: InvoiceOptions = {}) {
		return this.invoices.verifyImage(input, options)
	}
	verify(input: InvoiceInput = invoice, options: InvoiceOptions = {}) {
		return this.invoices.verify(input, options)
	}
}

export async function setup(
	config: { vlm?: typeof settings; timeoutMs?: number; captchaAttempts?: number } = {
		vlm: settings,
	},
	realBrowser?: Browser,
	apiKey = 'test-secret',
) {
	const emitter = new EventEmitter()
	const newContext = vi.fn(async () => {
		throw new Error('Unexpected browser acquisition')
	})
	const browser =
		realBrowser ??
		(Object.assign(emitter, {
			isConnected: () => true,
			close: vi.fn(async () => {}),
			newContext,
		}) as unknown as Browser)
	vi.spyOn(chromium, 'connectOverCDP').mockResolvedValue(browser)
	const credentials = defineHostService({
		name: 'Invoice test credentials',
		requires: { vault: Vault },
		capabilities: [],
		async prepare({ ctx }) {
			await ctx.require(HostVaultBindings).install([
				{
					owner: pluginNodeAddressOf(InvoicePlugin),
					key: 'primary',
					value: { apiKey },
					source: 'env',
				},
			])
		},
	})
	const host = await createTestHost({ services: [vault({ backend: 'bindings' }), credentials] })
	try {
		await host.commit((change) => {
			change.catalog.add([PlaywrightPlugin, InvoicePlugin, Consumer])
			change.start(PlaywrightPlugin, { initialConfig: { endpoint: 'http://127.0.0.1:9222' } })
			change.start(InvoicePlugin, { initialConfig: config })
			change.start(Consumer)
		})
		return { host, consumer: host.require(Consumer), newContext }
	} catch (error) {
		await host.dispose()
		throw error
	}
}
