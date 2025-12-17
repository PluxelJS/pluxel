import { describe, expect, it } from 'bun:test'

import { BasePlugin, ForkablePlugin, Plugin, setParamToken, withTestHost } from '@pluxel/core/test'

describe('Forkable plugins', () => {
	it('rejects forking non‑forkable plugins', () => {
		return withTestHost((host) => {
			@Plugin({ name: 'NotForkable' })
			class NotForkable extends BasePlugin {}

			expect(() => host.fork(NotForkable as any, 'a')).toThrow()
		})
	})

	it('runs multiple forks with isolated ctx and identity', async () => {
		await withTestHost(async (host) => {
			const events: string[] = []

			@Plugin({ name: 'Forkee' })
			class Forkee extends ForkablePlugin {
				override init(): void {
					events.push(this.ctx.pluginInfo.id)
				}
			}

			host.registerFork(Forkee, 'a')
			host.registerFork(Forkee, 'b')
			await host.commitStrict()

			expect(new Set(events)).toEqual(new Set(['Forkee#a', 'Forkee#b']))

			const a = host.getFork(Forkee, 'a')
			const b = host.getFork(Forkee, 'b')
			expect(a).toBeDefined()
			expect(b).toBeDefined()
			expect(a).not.toBe(b)
			expect(a!.ctx).not.toBe(b!.ctx)
			expect(a!.ctx.pluginInfo.id).toBe('Forkee#a')
			expect(b!.ctx.pluginInfo.id).toBe('Forkee#b')
		})
	})

	it('allows setParamToken to inject a specific fork', async () => {
		await withTestHost(async (host) => {
			@Plugin({ name: 'Dep' })
			class Dep extends ForkablePlugin {}

			const DepA = host.fork(Dep, 'a')
			const DepB = host.fork(Dep, 'b')

			@Plugin({ name: 'Consumer' })
			class Consumer extends BasePlugin {
				public dep: Dep
				constructor(dep: Dep) {
					super()
					this.dep = dep
				}
			}

			setParamToken(Consumer, 0, DepB)

			host.registerAll(DepA, DepB, Consumer)
			await host.commitStrict()

			const consumer = host.getOrThrow(Consumer) as Consumer
			expect(consumer.dep.ctx.pluginInfo.id).toBe('Dep#b')
		})
	})
})
