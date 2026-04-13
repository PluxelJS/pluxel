import { describe, expect, it } from 'vitest'

import { BasePlugin, Plugin, withHost } from '@pluxel/test'

describe('PluginService watchInstance()', () => {
	it('tracks alias resolution from unavailable to started to replaced to removed', async () => {
		await withHost(async (host) => {
			abstract class Abs extends BasePlugin {}

			@Plugin(Abs, { name: 'WATCH-A' })
			class A extends Abs {}

			@Plugin(Abs, { name: 'WATCH-B' })
			class B extends Abs {}

			const seen: string[] = []
			const off = host.ctx.registry.watchInstance(Abs, (instance) => {
				seen.push(instance?.constructor.name ?? 'none')
			})

			expect(seen).toEqual(['none'])

			await host.start(A, { provideBase: true })
			expect(seen).toEqual(['none', 'A'])

			await host.commit()
			expect(seen).toEqual(['none', 'A'])

			host.replace(A, B, { provideBase: true })
			await host.commit()
			expect(seen).toEqual(['none', 'A', 'B'])

			host.remove(B)
			await host.commit()
			expect(seen).toEqual(['none', 'A', 'B', 'none'])

			off()
		})
	})

	it('marks restart-only commits as touched and re-emits the restarted instance once', async () => {
		await withHost(async (host) => {
			const seen: string[] = []
			let seq = 0

			@Plugin({ name: 'WATCH-RESTART' })
			class Restartable extends BasePlugin {
				public readonly label = `instance-${++seq}`
			}

			host.ctx.registry.watchInstance(Restartable, (instance) => {
				seen.push(instance?.label ?? 'none')
			})

			await host.start(Restartable)
			const first = host.require(Restartable)
			expect(seen).toEqual(['none', first.label])

			host.restart(Restartable)
			const summary = await host.commit()
			const second = host.require(Restartable)

			expect(summary.added).toEqual([])
			expect(summary.removed).toEqual([])
			expect(summary.replaced).toEqual([])
			expect(summary.failed).toEqual([])
			expect(summary.touched).toEqual([Restartable])
			expect(second).not.toBe(first)
			expect(seen).toEqual(['none', first.label, second.label])
		})
	})
})
