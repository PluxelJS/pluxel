import { describe, expect, it } from 'vitest'

import { BasePlugin, ForkablePlugin, Plugin, setParamToken, withCoreHost } from '@pluxel/core/test'

describe('Abstract base and canonical ids', () => {
	it('injects abstract base and resolves by impl ctor', async () => {
		await withCoreHost(async (host) => {
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
			setParamToken(Consumer, 0, Abs)

			host.add([Impl, Consumer])
			await host.commit()

			const consumer = host.require(Consumer) as Consumer
			expect(consumer.dep).toBeInstanceOf(Impl)
			expect(consumer.dep.ping()).toBe('ok')

			// impl ctor should still be a valid identifier for queries
			expect(host.isRunning(Impl)).toBe(true)
			expect(host.get(Impl)).toBeInstanceOf(Impl)

			// base token should also resolve via alias
			expect(host.isRunning(Abs)).toBe(true)
			expect(host.get(Abs)).toBeInstanceOf(Impl)

			// unloading by base should remove provider + dependents
			host.remove(Abs)
			await host.commit()
			expect(host.isRunning(Impl)).toBe(false)
			expect(host.isRunning(Abs)).toBe(false)
		})
	})

	it('starts base provider before consumer in the same commit', async () => {
		await withCoreHost(async (host) => {
			const events: string[] = []
			let providerReady = false

			abstract class Abs extends BasePlugin {}

			@Plugin(Abs, { name: 'Provider' })
			class Provider extends Abs {
				override async init(): Promise<void> {
					await Promise.resolve()
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
			setParamToken(Consumer, 0, Abs)

			host.add([Provider, Consumer])
			await host.commit()
			expect(events).toEqual(['provider', 'consumer'])
		})
	})

	it('throws on multiple providers for the same base', async () => {
		await withCoreHost(async (host) => {
			abstract class Abs extends BasePlugin {}

			@Plugin(Abs, { name: 'Impl1' })
			class Impl1 extends Abs {}
			@Plugin(Abs, { name: 'Impl2' })
			class Impl2 extends Abs {}

			host.add([Impl1, Impl2])
			await expect(host.commit()).rejects.toThrow(/service verification failed/i)
		})
	})

	it('forks of a base plugin do not replace the base provider', async () => {
		await withCoreHost(async (host) => {
			abstract class Abs extends ForkablePlugin {}

			@Plugin(Abs, { name: 'Impl' })
			class Impl extends Abs {}

			@Plugin({ name: 'Consumer' })
			class Consumer extends BasePlugin {
				constructor(public dep: Abs) {
					super()
				}
			}
			setParamToken(Consumer, 0, Abs)

			host.add(Impl)
			const A = host.fork(Impl, 'a')
			const B = host.fork(Impl, 'b')
			host.add(Consumer)
			await host.commit()

			const consumer = host.require(Consumer) as Consumer
			expect(consumer.dep.ctx.pluginInfo.id).toBe('Impl')

			// base token resolves to the primary provider, not forks
			const base = host.get(Abs) as Abs | undefined
			expect(base?.ctx.pluginInfo.id).toBe('Impl')

			expect(host.require(A).ctx.pluginInfo.id).toBe('Impl#a')
			expect(host.require(B).ctx.pluginInfo.id).toBe('Impl#b')
		})
	})

	it('can opt a fork into providing base (and conflicts)', async () => {
		await withCoreHost(async (host) => {
			abstract class Abs extends ForkablePlugin {}

			@Plugin(Abs, { name: 'Impl' })
			class Impl extends Abs {}

			host.add(Impl)
			host.fork(Impl, 'a', { provideBase: true })

			await expect(host.commit()).rejects.toThrow(/service verification failed/i)
		})
	})
})
