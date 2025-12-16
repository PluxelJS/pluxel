import { describe, expect, it } from 'bun:test'

import { BasePlugin, ForkablePlugin, Plugin, withPluginTestHost } from '@pluxel/core/test'

describe('Abstract base and canonical ids', () => {
	it('injects abstract base and resolves by impl ctor', async () => {
		await withPluginTestHost(async (host) => {
			abstract class Abs extends BasePlugin {
				abstract ping(): string
			}

			@Plugin(Abs, { name: 'Impl' })
			class Impl extends Abs {
				ping() {
					return 'ok'
				}
			}

			@Plugin({ name: 'Consumer' })
			class Consumer extends BasePlugin {
				public dep: Abs
				constructor(dep: Abs) {
					super()
					this.dep = dep
				}
			}

			host.registerAll(Impl, Consumer)
			await host.commitStrict()

			const consumer = host.getOrThrow(Consumer) as Consumer
			expect(consumer.dep).toBeInstanceOf(Impl)
			expect(consumer.dep.ping()).toBe('ok')

			// impl ctor should still be a valid identifier for queries
			expect(host.isRunning(Impl)).toBe(true)
			let opt: Impl | undefined
			host.optional(Impl, (dep) => {
				opt = dep
			})
			await Promise.resolve()
			expect(opt).toBeInstanceOf(Impl)

			// base token should also resolve via alias
			expect(host.isRunning(Abs)).toBe(true)
			let optByBase: Abs | undefined
			host.optional(Abs as any, (dep) => {
				optByBase = dep as any
			})
			await Promise.resolve()
			expect(optByBase).toBeInstanceOf(Impl)

			// unloading by base should remove provider + dependents
			host.unregister(Abs as any)
			await host.commitStrict()
			expect(host.isRunning(Impl)).toBe(false)
			expect(host.isRunning(Abs as any)).toBe(false)
		})
	})

	it('starts base provider before consumer in the same commit', async () => {
		await withPluginTestHost(async (host) => {
			const events: string[] = []
			let providerReady = false

			abstract class Abs extends BasePlugin {}

			@Plugin(Abs, { name: 'Provider' })
			class Provider extends Abs {
				override async init(): Promise<void> {
					await new Promise((r) => setTimeout(r, 10))
					providerReady = true
					events.push('provider')
				}
			}

			@Plugin({ name: 'Consumer' })
			class Consumer extends BasePlugin {
				constructor(_dep: Abs) {
					super()
				}

				override init(): void {
					if (!providerReady) throw new Error('provider should start before consumer')
					events.push('consumer')
				}
			}

			host.registerAll(Provider, Consumer)
			await host.commitStrict()
			expect(events).toEqual(['provider', 'consumer'])
		})
	})

	it('throws on multiple providers for the same base', async () => {
		await withPluginTestHost(async (host) => {
			abstract class Abs extends BasePlugin {}

			@Plugin(Abs, { name: 'Impl1' })
			class Impl1 extends Abs {}
			@Plugin(Abs, { name: 'Impl2' })
			class Impl2 extends Abs {}

			host.registerAll(Impl1, Impl2)
			// alias conflict is detected at build/commit time (deterministic error)
			const res = await host.commitResult()
			expect(res.ok).toBe(false)
		})
	})

	it('forks of a base plugin do not replace the base provider', async () => {
		await withPluginTestHost(async (host) => {
			abstract class Abs extends ForkablePlugin {}

			@Plugin(Abs, { name: 'Impl' })
			class Impl extends Abs {}

			@Plugin({ name: 'Consumer' })
			class Consumer extends BasePlugin {
				constructor(public dep: Abs) {
					super()
				}
			}

			host.register(Impl)
			host.registerFork(Impl, 'a')
			host.registerFork(Impl, 'b')
			host.register(Consumer)
			await host.commitStrict()

			const consumer = host.getOrThrow(Consumer) as Consumer
			expect(consumer.dep.ctx.pluginInfo.id).toBe('Impl')

			// base token resolves to the primary provider, not forks
			let base: Abs | undefined
			host.optional(Abs as any, (dep) => {
				base = dep as any
			})
			await Promise.resolve()
			expect(base?.ctx.pluginInfo.id).toBe('Impl')

			expect(host.getFork(Impl, 'a')!.ctx.pluginInfo.id).toBe('Impl#a')
			expect(host.getFork(Impl, 'b')!.ctx.pluginInfo.id).toBe('Impl#b')
		})
	})

	it('can opt a fork into providing base (and conflicts)', async () => {
		await withPluginTestHost(async (host) => {
			abstract class Abs extends ForkablePlugin {}

			@Plugin(Abs, { name: 'Impl' })
			class Impl extends Abs {}

			host.register(Impl)
			host.registerFork(Impl, 'a', { provideBase: true })

			const res = await host.commitResult()
			expect(res.ok).toBe(false)
		})
	})
})
