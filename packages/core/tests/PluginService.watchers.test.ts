import { describe, expect, it } from 'vitest'

import { BasePlugin, Plugin, withCoreHost } from '@pluxel/core/test'

describe('PluginService watchInstance()', () => {
	it('tracks alias resolution from unavailable to started to replaced to removed', async () => {
		await withCoreHost(async (host) => {
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

	it('marks restart-only commits as availability changes and re-emits the restarted instance once', async () => {
		await withCoreHost(async (host) => {
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

			expect(summary.pluginChanges.added).toEqual([])
			expect(summary.pluginChanges.removed).toEqual([])
			expect(summary.pluginChanges.replaced).toEqual([])
			expect(summary.lifecycleReport.issues).toEqual([])
			expect(summary.pluginChanges.availabilityChanged).toEqual(['WATCH-RESTART'])
			expect(summary.pluginChanges.restarted).toEqual(['WATCH-RESTART'])
			expect(second).not.toBe(first)
			expect(seen).toEqual(['none', first.label, second.label])
		})
	})

	it('resolves watched ctor identity drift from runtime module ownership', async () => {
		await withCoreHost(async (host) => {
			@Plugin({ name: 'WATCH-DRIFT' })
			class Dep extends BasePlugin {}

			@Plugin({ name: 'WATCH-DRIFT' })
			class DepShadow extends BasePlugin {}

			const tx = host.ctx.registry.beginUpdate({ reason: 'hmr' })
			tx.upsertModule({
				moduleId: 'watch-drift.ts',
				items: [{ ctor: Dep, exportKey: 'Dep' }],
			})
			tx.register(Dep)
			const commitResult = await tx.commit()
			expect(commitResult.ok).toBe(true)

			const seen: string[] = []
			const off = host.ctx.registry.watchInstance(DepShadow, (instance) => {
				seen.push(instance?.constructor.name ?? 'none')
			})

			expect(seen).toEqual(['Dep'])
			off()
		})
	})
})
