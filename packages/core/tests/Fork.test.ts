import { describe, expect, it } from 'vitest'

import { BasePlugin, ForkablePlugin, Plugin, setParamToken, withHost } from '@pluxel/test'

describe('Forkable plugins', () => {
	it('rejects forking non‑forkable plugins', () => {
		return withHost((host) => {
			@Plugin({ name: 'NotForkable' })
			class NotForkable extends BasePlugin {}

			expect(() => host.fork(NotForkable as any, 'a')).toThrow()
		})
	})

	it('runs multiple forks with isolated ctx and identity', async () => {
		await withHost(async (host) => {
			const events: string[] = []

			@Plugin({ name: 'Forkee' })
			class Forkee extends ForkablePlugin {
				override init(): void {
					events.push(this.ctx.pluginInfo.id)
				}
			}

			const A = host.fork(Forkee, 'a')
			const B = host.fork(Forkee, 'b')
			await host.commit()

			expect(new Set(events)).toEqual(new Set(['Forkee#a', 'Forkee#b']))

			const a = host.get(A)
			const b = host.get(B)
			expect(a).toBeDefined()
			expect(b).toBeDefined()
			expect(a).not.toBe(b)
			expect(a!.ctx).not.toBe(b!.ctx)
			expect(a!.ctx.pluginInfo.id).toBe('Forkee#a')
			expect(b!.ctx.pluginInfo.id).toBe('Forkee#b')
		})
	})

	it('allows setParamToken to inject a specific fork', async () => {
		await withHost(async (host) => {
			@Plugin({ name: 'Dep' })
			class Dep extends ForkablePlugin {}

			const _DepA = host.fork(Dep, 'a')
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

			host.add(Consumer)
			await host.commit()

			const consumer = host.require(Consumer) as Consumer
			expect(consumer.dep.ctx.pluginInfo.id).toBe('Dep#b')
		})
	})
})
