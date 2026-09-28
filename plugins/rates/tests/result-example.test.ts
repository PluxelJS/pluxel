import { Plugin } from '@pluxel/core'
import { createTestHost } from '@pluxel/test'
import { expect, it } from 'vitest'
import {
	MemoryRatesBackendPlugin,
	RatesBackend,
	RatesPlugin,
	type RateDecision,
} from '../src/index.ts'
import { MessagingPlugin } from './fixtures/result-consumer.ts'

it('turns deny into a recoverable Result without delivering the denied message', async () => {
	await using host = await createTestHost()
	await host.start([MemoryRatesBackendPlugin, RatesPlugin, MessagingPlugin])
	const messages = host.require(MessagingPlugin)
	for (let i = 0; i < 100; i++) {
		const sent = await messages.send('tenant', 'alice')
		expect(sent.isOk()).toBe(true)
	}
	const denied = await messages.send('tenant', 'alice')
	expect(denied.isErr()).toBe(true)
	if (denied.isOk()) throw new Error('Expected quota denial')
	expect(denied.error._tag).toBe('MessageRateLimited')
	expect(denied.error.retryAfterMs).toBeGreaterThan(0)
	expect(denied.error.resetAt).toBeGreaterThan(0)
	expect(messages.deliveredCount()).toBe(100)
	const anotherTenant = await messages.send('another-tenant', 'alice')
	expect(anotherTenant.isOk()).toBe(true)
})

@Plugin(RatesBackend)
class OfflineRates extends RatesBackend {
	async consume(): Promise<RateDecision> {
		throw new Error('offline')
	}
}

it('keeps backend failure distinct from quota denial', async () => {
	await using host = await createTestHost()
	await host.start([OfflineRates, RatesPlugin, MessagingPlugin])
	const messages = host.require(MessagingPlugin)
	await expect(messages.send('tenant', 'alice')).rejects.toMatchObject({
		code: 'RATES_UNAVAILABLE',
	})
	expect(messages.deliveredCount()).toBe(0)
})
