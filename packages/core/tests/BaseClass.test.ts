import { describe, expect, it } from 'bun:test'

import { BasePlugin, Context, ForkablePlugin, Plugin } from './context'

describe('Abstract base and canonical ids', () => {
	it('injects abstract base and resolves by impl ctor', async () => {
		const ctx = new Context()

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

		ctx.registry.pluginRegistry.registerPlugin(Impl)
		ctx.registry.pluginRegistry.registerPlugin(Consumer)
		await ctx.registry.commit()

		const consumer = ctx.registry.pluginRegistry.lastContainer.get(Consumer) as Consumer | undefined
		expect(consumer).toBeDefined()
		expect(consumer!.dep).toBeInstanceOf(Impl)
		expect(consumer!.dep.ping()).toBe('ok')

		// impl ctor should still be a valid identifier for queries
		expect(ctx.registry.isRunning(Impl)).toBe(true)
		const opt = ctx.registry.optional(Impl)
		expect(opt).toBeInstanceOf(Impl)

		// base token should also resolve via alias
		expect(ctx.registry.isRunning(Abs)).toBe(true)
		const optByBase = ctx.registry.optional(Abs)
		expect(optByBase).toBeInstanceOf(Impl)

		// unloading by base should remove provider + dependents
		ctx.registry.pluginRegistry.unregisterPlugin(Abs)
		await ctx.registry.commit()
		expect(ctx.registry.isRunning(Impl)).toBe(false)
		expect(ctx.registry.isRunning(Abs)).toBe(false)
	})

	it('starts base provider before consumer in the same commit', async () => {
		const ctx = new Context()
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

		ctx.registry.pluginRegistry.registerPlugin(Provider)
		ctx.registry.pluginRegistry.registerPlugin(Consumer)
		const res = await ctx.registry.commit()
		expect(res.ok).toBe(true)
		expect(events).toEqual(['provider', 'consumer'])
	})

	it('throws on multiple providers for the same base', async () => {
		const ctx = new Context()

		abstract class Abs extends BasePlugin {}

		@Plugin(Abs, { name: 'Impl1' })
		class Impl1 extends Abs {}
		@Plugin(Abs, { name: 'Impl2' })
		class Impl2 extends Abs {}

		ctx.registry.pluginRegistry.registerPlugin(Impl1)
		ctx.registry.pluginRegistry.registerPlugin(Impl2)
		// alias conflict is detected at build/commit time (deterministic error)
		expect((await ctx.registry.commit()).ok).toBe(false)
	})

	it('forks of a base plugin do not replace the base provider', async () => {
		const ctx = new Context()

		abstract class Abs extends ForkablePlugin {}

		@Plugin(Abs, { name: 'Impl' })
		class Impl extends Abs {}

		@Plugin({ name: 'Consumer' })
		class Consumer extends BasePlugin {
			constructor(public dep: Abs) {
				super()
			}
		}

		ctx.registry.pluginRegistry.registerPlugin(Impl)
		ctx.registry.registerFork(Impl, 'a')
		ctx.registry.registerFork(Impl, 'b')
		ctx.registry.pluginRegistry.registerPlugin(Consumer)
		await ctx.registry.commit()

		const consumer = ctx.registry.pluginRegistry.lastContainer.get(Consumer) as Consumer | undefined
		expect(consumer).toBeDefined()
		expect(consumer!.dep.ctx.pluginInfo.id).toBe('Impl')

		// base token resolves to the primary provider, not forks
		expect(ctx.registry.optional(Abs)?.ctx.pluginInfo.id).toBe('Impl')

		expect(ctx.registry.getFork(Impl, 'a')!.ctx.pluginInfo.id).toBe('Impl#a')
		expect(ctx.registry.getFork(Impl, 'b')!.ctx.pluginInfo.id).toBe('Impl#b')
	})

	it('can opt a fork into providing base (and conflicts)', async () => {
		const ctx = new Context()

		abstract class Abs extends ForkablePlugin {}

		@Plugin(Abs, { name: 'Impl' })
		class Impl extends Abs {}

		ctx.registry.pluginRegistry.registerPlugin(Impl)
		ctx.registry.registerFork(Impl, 'a', { provideBase: true })

		const res = await ctx.registry.commit()
		expect(res.ok).toBe(false)
	})
})
