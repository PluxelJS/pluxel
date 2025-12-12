import { describe, expect, it } from 'bun:test'

import { BasePlugin, Context, ForkablePlugin, Plugin, setParamToken } from './context'

describe('Forkable plugins', () => {
	it('rejects forking non‑forkable plugins', () => {
		const ctx = new Context()

		@Plugin({ name: 'NotForkable' })
		class NotForkable extends BasePlugin {}

		expect(() => ctx.registry.fork(NotForkable as any, 'a')).toThrow()
	})

	it('runs multiple forks with isolated ctx and identity', async () => {
		const ctx = new Context()
		const events: string[] = []

		@Plugin({ name: 'Forkee' })
		class Forkee extends ForkablePlugin {
			override init(): void {
				events.push(this.ctx.pluginInfo.id)
			}
		}

		ctx.registry.registerFork(Forkee, 'a')
		ctx.registry.registerFork(Forkee, 'b')
		await ctx.registry.commit()

		expect(new Set(events)).toEqual(new Set(['Forkee#a', 'Forkee#b']))

		const a = ctx.registry.getFork(Forkee, 'a')
		const b = ctx.registry.getFork(Forkee, 'b')
		expect(a).toBeDefined()
		expect(b).toBeDefined()
		expect(a).not.toBe(b)
		expect(a!.ctx).not.toBe(b!.ctx)
		expect(a!.ctx.pluginInfo.id).toBe('Forkee#a')
		expect(b!.ctx.pluginInfo.id).toBe('Forkee#b')
	})

	it('allows setParamToken to inject a specific fork', async () => {
		const ctx = new Context()

		@Plugin({ name: 'Dep' })
		class Dep extends ForkablePlugin {}

		const DepA = ctx.registry.fork(Dep, 'a')
		const DepB = ctx.registry.fork(Dep, 'b')

		@Plugin({ name: 'Consumer' })
		class Consumer extends BasePlugin {
			public dep: Dep
			constructor(dep: Dep) {
				super()
				this.dep = dep
			}
		}

		setParamToken(Consumer, 0, DepB)

		ctx.registry.pluginRegistry.registerPlugin(DepA)
		ctx.registry.pluginRegistry.registerPlugin(DepB)
		ctx.registry.pluginRegistry.registerPlugin(Consumer)
		await ctx.registry.commit()

		const consumer = ctx.registry.pluginRegistry.lastContainer.get(Consumer) as Consumer | undefined
		expect(consumer).toBeDefined()
		expect(consumer!.dep.ctx.pluginInfo.id).toBe('Dep#b')
	})
})

