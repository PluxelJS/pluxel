import type { PluginConstructor } from '@pluxel/runtime'
import {
	BasePlugin,
	createRuntimeTestHost,
	Plugin,
	type RuntimeTestHost,
} from '@pluxel/runtime/test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	MemoryRatesBackendPlugin,
	Rates,
	RatesBackend,
	RatesInvalidArgumentError,
	RatesPlugin,
	RatesPolicyConflictError,
	RatesStoppedError,
	RatesUnavailableError,
	type RateLimiter,
	type RatePolicy,
	type RateDecision,
	type RatesBackendConsumeRequest,
} from '../src/index.ts'
import { ExpiryHeap } from '../src/expiry-heap.ts'

const Fixed = { algorithm: 'fixed-window', limit: 2, windowMs: 1_000 } as const

async function startPlugins(
	host: RuntimeTestHost,
	plugins: readonly PluginConstructor[],
): Promise<void> {
	await host.start(plugins)
}

function createHost(): RuntimeTestHost {
	return createRuntimeTestHost()
}

@Plugin({ displayName: 'RatesConsumer' })
class ConsumerA extends BasePlugin {
	local!: RateLimiter
	shared!: RateLimiter
	constructor(readonly rates: Rates) {
		super()
	}
	protected override init(): void {
		this.local = this.rates.use('messages', Fixed)
		this.shared = this.rates.global.use('platform.messages', Fixed)
	}
}

@Plugin({ displayName: 'RatesConsumer' })
class ConsumerB extends BasePlugin {
	local!: RateLimiter
	shared!: RateLimiter
	constructor(readonly rates: Rates) {
		super()
	}
	protected override init(): void {
		this.local = this.rates.use('messages', Fixed)
		this.shared = this.rates.global.use('platform.messages', Fixed)
	}
}

@Plugin(RatesBackend)
class BrokenRatesBackend extends RatesBackend {
	async consume(_request: RatesBackendConsumeRequest): Promise<RateDecision> {
		throw new Error('offline')
	}
}

@Plugin(RatesBackend)
class MalformedRatesBackend extends RatesBackend {
	private calls = 0

	async consume(_request: RatesBackendConsumeRequest): Promise<RateDecision> {
		this.calls += 1
		if (this.calls === 1) return { denied: false, remaining: Number.NaN, resetAt: 1 }
		if (this.calls === 2) return { denied: false, remaining: 3, resetAt: 1 }
		return { denied: true, remaining: 1, retryAfterMs: 1, resetAt: 1 }
	}
}

let finishDelayedDecision: ((decision: RateDecision) => void) | undefined

@Plugin(RatesBackend)
class DelayedRatesBackend extends RatesBackend {
	consume(_request: RatesBackendConsumeRequest): Promise<RateDecision> {
		return new Promise((resolve) => {
			finishDelayedDecision = resolve
		})
	}
}

afterEach(() => vi.useRealTimers())

describe('@pluxel/rates public API', () => {
	it('binds local quotas to callers and shares only explicit global quotas', async () => {
		{
			await using host = createHost()

			await startPlugins(host, [MemoryRatesBackendPlugin, RatesPlugin, ConsumerA, ConsumerB])
			const a = host.require(ConsumerA)
			const b = host.require(ConsumerB)
			expect(await a.local.consume('same')).toMatchObject({ denied: false })
			expect(await a.local.consume('same')).toMatchObject({ denied: false })
			expect(await a.local.consume('same')).toMatchObject({ denied: true })
			expect(await b.local.consume('same')).toMatchObject({ denied: false })
			expect(await a.shared.consume('shared')).toMatchObject({ denied: false })
			expect(await b.shared.consume('shared')).toMatchObject({ denied: false })
			expect(await b.shared.consume('shared')).toMatchObject({ denied: true })
		}
	})

	it('snapshots policies and detects registration conflicts', async () => {
		{
			await using host = createHost()

			await startPlugins(host, [MemoryRatesBackendPlugin, RatesPlugin, ConsumerA])
			const rates = host.require(ConsumerA).rates
			const input = { algorithm: 'token-bucket', limit: 3, windowMs: 1_000 } as RatePolicy
			const first = rates.use('api', input)
			input.limit = 99
			const second = rates.use('api', { algorithm: 'token-bucket', limit: 3, windowMs: 1_000 })
			expect(second).toBe(first)
			expect(() =>
				rates.use('api', { algorithm: 'token-bucket', limit: 4, windowMs: 1_000 }),
			).toThrow(RatesPolicyConflictError)
			expect(() =>
				rates.global.use('platform.messages', {
					algorithm: 'fixed-window',
					limit: 3,
					windowMs: 1_000,
				}),
			).toThrow(RatesPolicyConflictError)
			expect(await first.consume('user', { cost: 3 })).toMatchObject({ denied: false })
			expect(await first.consume('user')).toMatchObject({ denied: true })
		}
	})

	it('canonicalizes tuple and sorted record identities without collisions', async () => {
		{
			await using host = createHost()

			await startPlugins(host, [MemoryRatesBackendPlugin, RatesPlugin, ConsumerA])
			const limiter = host.require(ConsumerA).rates.use('identity', {
				algorithm: 'fixed-window',
				limit: 1,
				windowMs: 1_000,
			})
			expect(await limiter.consume({ tenant: 'a', user: 1 })).toMatchObject({ denied: false })
			expect(await limiter.consume({ user: 1, tenant: 'a' })).toMatchObject({ denied: true })
			expect(await limiter.consume(['a', 1])).toMatchObject({ denied: false })
			expect(await limiter.consume('a')).toMatchObject({ denied: false })
			expect(await limiter.consume(-0)).toMatchObject({ denied: false })
			expect(await limiter.consume(0)).toMatchObject({ denied: false })
			expect(await limiter.consume('\u{1f680}')).toMatchObject({ denied: false })
			expect(await limiter.consume({ ['\u{1f680}']: 'value' })).toMatchObject({ denied: false })
		}
	})

	it('rejects invalid use synchronously and invalid consume through its promise', async () => {
		{
			await using host = createHost()

			await startPlugins(host, [MemoryRatesBackendPlugin, RatesPlugin, ConsumerA])
			const rates = host.require(ConsumerA).rates
			expect(() => rates.use(' padded ', Fixed)).toThrow(RatesInvalidArgumentError)
			expect(() => rates.use('invalid\ud800', Fixed)).toThrow(RatesInvalidArgumentError)
			expect(() => rates.use('bad', { ...Fixed, extra: true } as never)).toThrow(
				RatesInvalidArgumentError,
			)
			expect(() =>
				rates.use('overflow-token', {
					algorithm: 'token-bucket',
					limit: 1,
					windowMs: 2,
					burst: Number.MAX_SAFE_INTEGER,
				}),
			).toThrow(RatesInvalidArgumentError)
			expect(() =>
				rates.use('oversized-log', {
					algorithm: 'sliding-window-log',
					limit: 10_001,
					windowMs: 1_000,
				}),
			).toThrow(RatesInvalidArgumentError)
			const accessorPolicy = { algorithm: 'fixed-window', limit: 1 } as Record<string, unknown>
			Object.defineProperty(accessorPolicy, 'windowMs', { enumerable: true, get: () => 1_000 })
			expect(() => rates.use('accessor-policy', accessorPolicy as never)).toThrow(
				RatesInvalidArgumentError,
			)
			const limiter = rates.use('valid', Fixed)
			await expect(limiter.consume('\ud800')).rejects.toBeInstanceOf(RatesInvalidArgumentError)
			await expect(limiter.consume(Number.NaN)).rejects.toMatchObject({
				code: 'RATES_INVALID_ARGUMENT',
				argument: 'identity',
			})
			await expect(limiter.consume('x', { cost: 3 })).rejects.toMatchObject({
				code: 'RATES_INVALID_ARGUMENT',
				argument: 'cost',
			})
			await expect(limiter.consume('x'.repeat(1_025))).rejects.toBeInstanceOf(
				RatesInvalidArgumentError,
			)
			await expect(limiter.consume({ nested: {} } as never)).rejects.toBeInstanceOf(
				RatesInvalidArgumentError,
			)
			const accessorTuple = ['value']
			Object.defineProperty(accessorTuple, '0', { enumerable: true, get: () => 'value' })
			await expect(limiter.consume(accessorTuple)).rejects.toBeInstanceOf(RatesInvalidArgumentError)
			const symbolRecord = { value: 'safe', [Symbol('hidden')]: 'secret' }
			await expect(limiter.consume(symbolRecord)).rejects.toBeInstanceOf(RatesInvalidArgumentError)
			const accessorOptions = {} as { cost?: number }
			Object.defineProperty(accessorOptions, 'cost', { enumerable: true, get: () => 1 })
			await expect(limiter.consume('x', accessorOptions)).rejects.toBeInstanceOf(
				RatesInvalidArgumentError,
			)
		}
	})

	it('wraps unknown backend failures and never synthesizes a decision', async () => {
		{
			await using host = createHost()

			await startPlugins(host, [BrokenRatesBackend, RatesPlugin, ConsumerA])
			await expect(host.require(ConsumerA).local.consume('user')).rejects.toBeInstanceOf(
				RatesUnavailableError,
			)
		}
	})

	it('rejects malformed third-party backend decisions at the coordinator boundary', async () => {
		{
			await using host = createHost()

			await startPlugins(host, [MalformedRatesBackend, RatesPlugin, ConsumerA])
			await expect(host.require(ConsumerA).local.consume('user')).rejects.toMatchObject({
				code: 'RATES_UNAVAILABLE',
				cause: expect.any(TypeError),
			})
			await expect(host.require(ConsumerA).local.consume('other')).rejects.toMatchObject({
				code: 'RATES_UNAVAILABLE',
				cause: expect.any(TypeError),
			})
			await expect(host.require(ConsumerA).local.consume('third')).rejects.toMatchObject({
				code: 'RATES_UNAVAILABLE',
				cause: expect.any(TypeError),
			})
		}
	})

	it('revokes cached limiter handles when the Rates provider stops', async () => {
		{
			await using host = createHost()

			await startPlugins(host, [MemoryRatesBackendPlugin, RatesPlugin, ConsumerA])
			const limiter = host.require(ConsumerA).local
			await expect(limiter.consume('live')).resolves.toMatchObject({ denied: false })

			await host.stop(RatesPlugin)

			await expect(limiter.consume('late')).rejects.toBeInstanceOf(RatesStoppedError)
		}
	})

	it('revokes caller-local and global limiter handles when the caller stops', async () => {
		{
			await using host = createHost()

			await startPlugins(host, [MemoryRatesBackendPlugin, RatesPlugin, ConsumerA, ConsumerB])
			const a = host.require(ConsumerA)
			const b = host.require(ConsumerB)
			await expect(a.shared.consume('shared')).resolves.toMatchObject({ denied: false })

			await host.stop(ConsumerA)

			await expect(a.local.consume('late')).rejects.toBeInstanceOf(RatesStoppedError)
			await expect(a.shared.consume('shared')).rejects.toBeInstanceOf(RatesStoppedError)
			await expect(b.shared.consume('shared')).resolves.toMatchObject({ denied: false })
		}
	})

	it('revokes cached limiter handles when the backend generation stops and restarts', async () => {
		{
			await using host = createHost()

			await startPlugins(host, [MemoryRatesBackendPlugin, RatesPlugin, ConsumerA])
			const limiter = host.require(ConsumerA).local
			await expect(limiter.consume('before')).resolves.toMatchObject({ denied: false })

			await host.stop(MemoryRatesBackendPlugin)
			await expect(limiter.consume('after')).rejects.toBeInstanceOf(RatesStoppedError)

			await host.start(MemoryRatesBackendPlugin)
			await expect(host.require(ConsumerA).local.consume('after')).resolves.toMatchObject({
				denied: false,
			})
		}
	})

	it('does not roll back or revoke an already submitted backend decision', async () => {
		finishDelayedDecision = undefined
		{
			await using host = createHost()

			await startPlugins(host, [DelayedRatesBackend, RatesPlugin, ConsumerA])
			const pending = host.require(ConsumerA).local.consume('in-flight')
			const stopping = host.stop(ConsumerA)
			if (!finishDelayedDecision) throw new Error('Delayed backend was not invoked')
			finishDelayedDecision({ denied: false, remaining: 0, resetAt: 1 })
			await expect(pending).resolves.toEqual({ denied: false, remaining: 0, resetAt: 1 })
			await stopping
		}
	})

	it('does not let a stopped memory backend handle recreate its state', async () => {
		{
			await using host = createHost()

			await startPlugins(host, [MemoryRatesBackendPlugin, RatesPlugin, ConsumerA])
			const backend = host.require(MemoryRatesBackendPlugin)
			await backend.consume({ key: 'saved', owner: null, policy: Fixed, cost: 1 })

			await host.commit((change) => {
				for (const PluginClass of [ConsumerA, RatesPlugin, MemoryRatesBackendPlugin]) {
					change.stop(PluginClass)
				}
			})

			await expect(
				backend.consume({ key: 'late', owner: null, policy: Fixed, cost: 1 }),
			).rejects.toBeInstanceOf(RatesStoppedError)
		}
	})
})

describe('@pluxel/rates memory algorithms', () => {
	it('stores and verifies the full structured owner independently of the opaque key', async () => {
		{
			await using host = createHost()

			await startPlugins(host, [MemoryRatesBackendPlugin, RatesPlugin, ConsumerA])
			const backend = host.require(MemoryRatesBackendPlugin)
			await backend.consume({ key: 'owner-bound', owner: null, policy: Fixed, cost: 1 })
			await expect(
				backend.consume({
					key: 'owner-bound',
					owner: host.require(ConsumerA).ctx.pluginInfo.nodeAddress,
					policy: Fixed,
					cost: 1,
				}),
			).rejects.toThrow('owner does not match')
		}
	})

	it('keeps same-key consumption atomic before the async boundary', async () => {
		{
			await using host = createHost()

			await startPlugins(host, [MemoryRatesBackendPlugin, RatesPlugin, ConsumerA])
			const limiter = host.require(ConsumerA).rates.use('concurrent', {
				algorithm: 'sliding-window-log',
				limit: 100,
				windowMs: 60_000,
			})
			const decisions = await Promise.all(
				Array.from({ length: 250 }, () => limiter.consume('user')),
			)
			expect(decisions.filter((decision) => !decision.denied)).toHaveLength(100)
		}
	})

	it('reports exact integer retry/reset vectors at algorithm boundaries', async () => {
		vi.useFakeTimers()
		vi.setSystemTime(10_000)
		{
			await using host = createHost()

			await startPlugins(host, [MemoryRatesBackendPlugin, RatesPlugin, ConsumerA])
			const rates = host.require(ConsumerA).rates
			const token = rates.use('exact.token', {
				algorithm: 'token-bucket',
				limit: 4,
				windowMs: 1_000,
				burst: 4,
			})
			expect(await token.consume('user', { cost: 3 })).toEqual({
				denied: false,
				remaining: 1,
				resetAt: 10_750,
			})
			expect(await token.consume('user', { cost: 2 })).toEqual({
				denied: true,
				remaining: 1,
				retryAfterMs: 250,
				resetAt: 10_750,
			})

			const fixed = rates.use('exact.fixed', {
				algorithm: 'fixed-window',
				limit: 1,
				windowMs: 1_000,
			})
			await fixed.consume('user')
			vi.setSystemTime(10_999)
			expect(await fixed.consume('user')).toEqual({
				denied: true,
				remaining: 0,
				retryAfterMs: 1,
				resetAt: 11_000,
			})
			vi.setSystemTime(11_000)
			expect(await fixed.consume('user')).toEqual({ denied: false, remaining: 0, resetAt: 12_000 })

			vi.setSystemTime(20_000)
			const counter = rates.use('exact.counter', {
				algorithm: 'sliding-window-counter',
				limit: 2,
				windowMs: 1_000,
			})
			await counter.consume('user', { cost: 2 })
			expect(await counter.consume('user')).toEqual({
				denied: true,
				remaining: 0,
				retryAfterMs: 1_500,
				resetAt: 22_000,
			})
			vi.setSystemTime(21_500)
			expect(await counter.consume('user')).toEqual({
				denied: false,
				remaining: 0,
				resetAt: 23_000,
			})

			vi.setSystemTime(30_000)
			const log = rates.use('exact.log', {
				algorithm: 'sliding-window-log',
				limit: 5,
				windowMs: 1_000,
			})
			await log.consume('user', { cost: 2 })
			vi.setSystemTime(30_100)
			await log.consume('user', { cost: 2 })
			expect(await log.consume('user', { cost: 2 })).toEqual({
				denied: true,
				remaining: 1,
				retryAfterMs: 900,
				resetAt: 31_100,
			})
			vi.setSystemTime(31_000)
			expect(await log.consume('user', { cost: 2 })).toEqual({
				denied: false,
				remaining: 1,
				resetAt: 32_000,
			})
		}
	})

	it('fails closed at identity capacity and reports the earliest expiry', async () => {
		vi.useFakeTimers()
		vi.setSystemTime(20_000)
		{
			await using host = createHost()

			await host.commit((change) => {
				change.start(MemoryRatesBackendPlugin, {
					initialConfig: { maxIdentities: 1 },
				})
				change.start(RatesPlugin)
				change.start(ConsumerA)
			})
			const limiter = host.require(ConsumerA).rates.use('capacity', Fixed)
			await limiter.consume('existing')
			await expect(limiter.consume('attacker')).rejects.toMatchObject({
				code: 'RATES_UNAVAILABLE',
				retryAfterMs: 1_000,
			})
			vi.advanceTimersByTime(1_000)
			await expect(limiter.consume('attacker')).resolves.toMatchObject({ denied: false })
		}
	})

	it('bounds routine expiry cleanup while reclaiming one slot at capacity', async () => {
		vi.useFakeTimers()
		vi.setSystemTime(20_000)
		{
			await using host = createHost()

			await host.commit((change) => {
				change.start(MemoryRatesBackendPlugin, {
					initialConfig: { maxIdentities: 1_000 },
				})
				change.start(RatesPlugin)
				change.start(ConsumerA)
			})
			const limiter = host.require(ConsumerA).rates.use('bounded-cleanup', Fixed)
			await Promise.all(
				Array.from({ length: 1_000 }, (_, index) => limiter.consume(`identity-${index}`)),
			)
			vi.advanceTimersByTime(1_000)
			const deletes = vi.spyOn(ExpiryHeap.prototype, 'delete')

			await expect(limiter.consume('new-identity')).resolves.toMatchObject({ denied: false })
			expect(deletes).toHaveBeenCalledTimes(64)
			deletes.mockClear()

			// A second request also pays only the fixed routine budget even though hundreds
			// of expired identities remain queued.
			await expect(limiter.consume('another-new-identity')).resolves.toMatchObject({
				denied: false,
			})
			expect(deletes.mock.calls.length).toBeLessThanOrEqual(64)
		}
	})

	it('recreates the requested expired identity even when it is beyond the cleanup budget', async () => {
		vi.useFakeTimers()
		vi.setSystemTime(30_000)
		{
			await using host = createHost()

			await startPlugins(host, [MemoryRatesBackendPlugin])
			const backend = host.require(MemoryRatesBackendPlugin)
			for (let index = 0; index < 100; index++) {
				await backend.consume({
					key: index === 99 ? 'zzzz' : `key-${String(index).padStart(3, '0')}`,
					owner: null,
					policy: Fixed,
					cost: 1,
				})
			}
			vi.advanceTimersByTime(1_000)
			await expect(
				backend.consume({
					key: 'zzzz',
					owner: null,
					policy: Object.freeze({
						algorithm: 'token-bucket',
						limit: 1,
						windowMs: 1_000,
						burst: 1,
					}),
					cost: 1,
				}),
			).resolves.toMatchObject({ denied: false })
		}
	})

	it('uses the last observed logical time when the process clock rolls back', async () => {
		vi.useFakeTimers()
		vi.setSystemTime(50_000)
		{
			await using host = createHost()

			await startPlugins(host, [MemoryRatesBackendPlugin, RatesPlugin, ConsumerA])
			const limiter = host.require(ConsumerA).rates.use('clock-rollback', {
				algorithm: 'token-bucket',
				limit: 1,
				windowMs: 1_000,
			})
			await limiter.consume('user')
			vi.setSystemTime(49_000)
			expect(await limiter.consume('user')).toEqual({
				denied: true,
				remaining: 0,
				retryAfterMs: 1_000,
				resetAt: 51_000,
			})
		}
	})
})
