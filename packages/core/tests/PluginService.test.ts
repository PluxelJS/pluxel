import { describe, expect, it } from 'bun:test'

import { BasePlugin, Context, Plugin } from './context'
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
		const ctx = new Context()
		const { pluginRegistry } = ctx.registry
		const summaries: any[] = []
		ctx.on('afterCommit', (summary) => {
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

		pluginRegistry.registerPlugin(SlowPlugin)
		const first = ctx.registry.commit().then((result) => {
			firstResolved = true
			return result
		})

		while (!slowInitCalled) {
			await new Promise((resolve) => setTimeout(resolve, 0))
		}

		pluginRegistry.registerPlugin(PluginB)
		const second = ctx.registry.commit().then((result) => {
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

		const lastContainer = ctx.registry.pluginRegistry.lastContainer
		expect(lastContainer).toBeDefined()
		expect(lastContainer!.services.has(SlowPlugin)).toBe(true)
		expect(lastContainer!.services.has(PluginB)).toBe(true)
	})

	it('captures failing plugins and clears singletons for retries', async () => {
		const ctx = new Context()
		const { pluginRegistry } = ctx.registry

		@Plugin({ name: 'ThrowPlugin' })
		class ThrowPlugin extends BasePlugin {
			override init(): void {
				throw new Error('boom')
			}
		}

		pluginRegistry.registerPlugin(ThrowPlugin)
		const result = await ctx.registry.commit()
		expect(result.ok).toBe(true)

		const summary = ctx.registry.lastCommit
		expect(summary?.failed).toContain(ThrowPlugin)
		expect(summary?.added).toContain(ThrowPlugin)
		expect(ctx.registry.pluginRegistry.singletons.has(ThrowPlugin)).toBe(false)
	})

	it('allows optional deps to run logic after commit', async () => {
		const ctx = new Context()
		const { pluginRegistry } = ctx.registry
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

		pluginRegistry.registerPlugin(OptionalConsumer)
		await ctx.registry.commit()
		expect(events).toEqual(['consumer:init', 'after:miss'])

		pluginRegistry.registerPlugin(OptionalProvider)
		await ctx.registry.commit()

		expect(events).toEqual(['consumer:init', 'after:miss', 'provider:init', 'after:hit'])

		const immediate: string[] = []
		ctx.registry.optional(OptionalProvider, (dep) => {
			immediate.push(dep ? 'now:hit' : 'now:miss')
		})
		expect(immediate).toEqual(['now:hit'])
	})

	it('optionalImport wraps dynamic import errors with logging', async () => {
		const ctx = new Context()
		const logs: unknown[][] = []
		const originalWarn = ctx.logger.warn
		ctx.logger.warn = ((...args: unknown[]) => {
			logs.push(args)
		}) as any

		const ok = await ctx.registry.optionalImport(async () => 'ok')
		expect(ok).toBe('ok')

		const result = await ctx.registry.optionalImport(
			async () => {
				throw new Error('missing module')
			},
		)

		expect(result).toBeUndefined()
		expect(logs.length).toBe(1)
		expect(String(logs[0]?.[1] ?? '')).toContain('optionalImport')
		ctx.logger.warn = originalWarn
	})

	it('optional accepts promise-like dynamic imports directly', async () => {
		const ctx = new Context()
		const logs: unknown[][] = []
		const originalWarn = ctx.logger.warn
		ctx.logger.warn = ((...args: unknown[]) => {
			logs.push(args)
		}) as any

		const events: string[] = []

		const success = await ctx.registry.optional(
			() => Promise.resolve({ value: 42 }),
			(dep) => {
				events.push(dep ? 'promise:hit' : 'promise:miss')
			},
		)
		expect(success).toBeUndefined()

		const failure = await ctx.registry.optional(
			() => Promise.reject(new Error('dyn import fail')),
			(dep) => {
				events.push(dep ? 'promise:hit2' : 'promise:miss2')
			},
		)

		expect(failure).toBeUndefined()
		expect(events).toEqual(['promise:miss', 'promise:miss2'])
		expect(logs.length).toBeGreaterThanOrEqual(1)
		ctx.logger.warn = originalWarn
	})

	it('optional importer validates plugin exports and only returns running instances', async () => {
		const ctx = new Context()
		const { pluginRegistry } = ctx.registry
		pluginRegistry.registerPlugin(PluginB)
		await ctx.registry.commit()

		const hits: string[] = []
		const res = await ctx.registry.optional(
			() => Promise.resolve(PluginB),
			(instance) => {
				if (instance) hits.push((instance as any).constructor.name)
			},
		)
		expect(res).toBeInstanceOf(PluginB)
		expect(hits).toEqual(['PluginB'])

		const logs: unknown[][] = []
		const originalWarn = ctx.logger.warn
	ctx.logger.warn = ((...args: unknown[]) => logs.push(args)) as any

		const bad = await ctx.registry.optional(
			() => Promise.resolve([() => {}]),
			(instances) => {
				hits.push(instances ? 'some' : 'none')
			},
		)
		expect(bad).toBeUndefined()
		expect(hits[hits.length - 1]).toBe('none')
		expect(logs.length).toBeGreaterThan(0)
		ctx.logger.warn = originalWarn
	})

	it('optional injects caller context like a required dependency', async () => {
		const ctx = new Context()
		const { pluginRegistry } = ctx.registry
		const callerCtxs: Context[] = []
		let consumerCtx: Context | undefined

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
				const dep = this.ctx.registry.optional(OptionalCallerProvider, (p) => {
					if (p?.ctx.caller) callerCtxs.push(p.ctx.caller)
				})
				dep?.record()
			}
		}

		pluginRegistry.registerPlugin(OptionalCallerProvider)
		await ctx.registry.commit()

		pluginRegistry.registerPlugin(OptionalCallerConsumer)
		await ctx.registry.commit()

		expect(callerCtxs.length).toBeGreaterThanOrEqual(1)
		for (const caller of callerCtxs) {
			expect(caller).toBe(consumerCtx)
		}
	})

	it('retries failed plugins on later commits even without container changes', async () => {
		const ctx = new Context()
		const { pluginRegistry } = ctx.registry

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

		pluginRegistry.registerPlugin(Flaky)

		const first = await ctx.registry.commit()
		expect(first.ok).toBe(true)
		expect(ctx.registry.lastCommit?.failed).toContain(Flaky)
		expect(ctx.registry.isRunning(Flaky)).toBe(false)

		// No container changes, but Flaky should be retried.
		const second = await ctx.registry.commit()
		expect(second.ok).toBe(true)
		expect(ctx.registry.isRunning(Flaky)).toBe(true)
		expect(events).toEqual(['ok'])
	})
})
