import { describe, expect, it } from 'bun:test'

import { BasePlugin, Plugin, withPluginTestHost } from '@pluxel/core/test'
import { PluginB } from './plugins'

function createDeferred() {
	let resolve!: () => void
	let reject!: (reason?: unknown) => void
	const promise = new Promise<void>((res, rej) => {
		resolve = res
		reject = rej
	})
	return { promise, resolve, reject }
}

describe('PluginService commit()', () => {
	it('serializes overlapping commits and preserves plugin state', async () => {
		await withPluginTestHost(async (host) => {
			const summaries: any[] = []
			host.ctx.on('afterCommit', (summary) => {
				summaries.push(summary)
			})

			const slowInit = createDeferred()
			let slowInitCalled = false

			@Plugin({ name: 'SlowPlugin' })
			class SlowPlugin extends BasePlugin {
				override async init(): Promise<void> {
					slowInitCalled = true
					await slowInit.promise
				}
			}

			let firstResolved = false
			let secondResolved = false

			host.register(SlowPlugin)
			const first = host.commitResult().then((result) => {
				firstResolved = true
				return result
			})

			while (!slowInitCalled) {
				await new Promise((resolve) => setTimeout(resolve, 0))
			}

			host.register(PluginB)
			const second = host.commitResult().then((result) => {
				secondResolved = true
				return result
			})

			await new Promise((resolve) => setTimeout(resolve, 10))
			expect(firstResolved).toBe(false)
			expect(secondResolved).toBe(false)

			slowInit.resolve()

			const [firstResult, secondResult] = await Promise.all([first, second])

			expect(firstResolved).toBe(true)
			expect(secondResolved).toBe(true)
			expect(firstResult.ok).toBe(true)
			expect(secondResult.ok).toBe(true)

			expect(summaries.length).toBe(2)
			expect(summaries[0]?.added).toEqual([SlowPlugin])
			expect(new Set(summaries[1]?.added)).toEqual(new Set([PluginB]))

			const lastContainer = host.registry.lastCommit?.container
			expect(lastContainer).toBeDefined()
			expect(lastContainer!.services.has(SlowPlugin)).toBe(true)
			expect(lastContainer!.services.has(PluginB)).toBe(true)
		})
	})

	it('captures failing plugins and clears singletons for retries', async () => {
		await withPluginTestHost(async (host) => {
			@Plugin({ name: 'ThrowPlugin' })
			class ThrowPlugin extends BasePlugin {
				override init(): void {
					throw new Error('boom')
				}
			}

			host.register(ThrowPlugin)
			const result = await host.commitResult()
			expect(result.ok).toBe(true)

			const summary = host.registry.lastCommit
			expect(summary?.failed).toContain(ThrowPlugin)
			expect(summary?.added).toContain(ThrowPlugin)
			expect(host.get(ThrowPlugin)).toBeUndefined()
		})
	})

	it('allows optional deps to run logic after commit', async () => {
		await withPluginTestHost(async (host) => {
			const events: string[] = []

			@Plugin({ name: 'OptionalProvider' })
			class OptionalProvider extends BasePlugin {
				override init(): void {
					events.push('provider:init')
				}
			}

			@Plugin({ name: 'OptionalConsumer' })
			class OptionalConsumer extends BasePlugin {
				override init(): void {
					events.push('consumer:init')
					this.ctx.registry.optional(OptionalProvider, (dep) => {
						events.push(dep ? 'after:hit' : 'after:miss')
					})
				}
			}

			host.register(OptionalConsumer)
			await host.commitStrict()
			await Promise.resolve()
			expect(events).toEqual(['consumer:init', 'after:miss'])

			host.register(OptionalProvider)
			await host.commitStrict()
			await Promise.resolve()

			expect(events).toEqual(['consumer:init', 'after:miss', 'provider:init', 'after:hit'])

			const immediate: string[] = []
			host.optional(OptionalProvider, (dep) => {
				immediate.push(dep ? 'now:hit' : 'now:miss')
			})
			await Promise.resolve()
			expect(immediate).toEqual(['now:hit'])
		})
	})

	it('optional handles dynamic import errors and still runs effect', async () => {
		await withPluginTestHost(async (host) => {
			const ctx = host.ctx as any
			const logs: unknown[][] = []
			const originalWarn = ctx.logger.warn
			ctx.logger.warn = ((...args: unknown[]) => {
				logs.push(args)
			}) as any

			const events: string[] = []

			await host.optional(
				() => Promise.reject(new Error('dyn import fail')),
				(dep) => {
					events.push(dep ? 'promise:hit2' : 'promise:miss2')
				},
			)
			await Promise.resolve()
			expect(events).toEqual(['promise:miss2'])
			expect(logs.length).toBeGreaterThanOrEqual(1)
			ctx.logger.warn = originalWarn
		})
	})

	it('optional importer validates plugin exports and reflects running instances', async () => {
		await withPluginTestHost(async (host) => {
			const ctx = host.ctx as any
			host.register(PluginB)
			await host.commitStrict()

			const hits: string[] = []
			await host.optional(
				() => Promise.resolve(PluginB),
				(instance) => {
					if (instance) hits.push((instance as any).constructor.name)
				},
			)
			await Promise.resolve()
			expect(hits).toEqual(['PluginB'])

			const logs: unknown[][] = []
			const originalWarn = ctx.logger.warn
			ctx.logger.warn = ((...args: unknown[]) => logs.push(args)) as any

			await host.optional(
				() => Promise.resolve([() => {}]),
				(_instances) => void hits.push('none'),
			)
			expect(hits[hits.length - 1]).toBe('none')
			expect(logs.length).toBeGreaterThan(0)
			ctx.logger.warn = originalWarn
		})
	})

	it('optional injects caller context like a required dependency', async () => {
		await withPluginTestHost(async (host) => {
			const callerCtxs: any[] = []
			let consumerCtx: any | undefined

			@Plugin({ name: 'OptionalCallerProvider' })
			class OptionalCallerProvider extends BasePlugin {
				record(): void {
					if (this.ctx.caller) callerCtxs.push(this.ctx.caller)
				}
			}

			@Plugin({ name: 'OptionalCallerConsumer' })
			class OptionalCallerConsumer extends BasePlugin {
				override init(): void {
					consumerCtx = this.ctx
					this.ctx.registry.optional(OptionalCallerProvider, (p) => {
						if (p?.ctx.caller) callerCtxs.push(p.ctx.caller)
						p?.record()
					})
				}
			}

			host.register(OptionalCallerProvider)
			await host.commitStrict()

			host.register(OptionalCallerConsumer)
			await host.commitStrict()
			await Promise.resolve()

			expect(callerCtxs.length).toBeGreaterThanOrEqual(1)
			for (const caller of callerCtxs) {
				expect(caller).toBe(consumerCtx)
			}
		})
	})

	it('retries failed plugins on later commits even without container changes', async () => {
		await withPluginTestHost(async (host) => {
			let attempt = 0
			const events: string[] = []

			@Plugin({ name: 'Flaky' })
			class Flaky extends BasePlugin {
				override init(): void {
					attempt++
					if (attempt === 1) throw new Error('boom')
					events.push('ok')
				}
			}

			host.register(Flaky)

			const first = await host.commitResult()
			expect(first.ok).toBe(true)
			expect(host.registry.lastCommit?.failed).toContain(Flaky)
			expect(host.isRunning(Flaky)).toBe(false)

			// No container changes, but Flaky should be retried.
			const second = await host.commitResult()
			expect(second.ok).toBe(true)
			expect(host.isRunning(Flaky)).toBe(true)
			expect(events).toEqual(['ok'])
		})
	})
})
