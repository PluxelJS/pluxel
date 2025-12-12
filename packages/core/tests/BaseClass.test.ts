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
	})

	it('throws on multiple providers for the same base', () => {
		const ctx = new Context()

		abstract class Abs extends BasePlugin {}

		@Plugin(Abs, { name: 'Impl1' })
		class Impl1 extends Abs {}
		@Plugin(Abs, { name: 'Impl2' })
		class Impl2 extends Abs {}

		ctx.registry.pluginRegistry.registerPlugin(Impl1)
		expect(() => ctx.registry.pluginRegistry.registerPlugin(Impl2)).toThrow()
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

		expect(ctx.registry.getFork(Impl, 'a')!.ctx.pluginInfo.id).toBe('Impl#a')
		expect(ctx.registry.getFork(Impl, 'b')!.ctx.pluginInfo.id).toBe('Impl#b')
	})
})

