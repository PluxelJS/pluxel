import { describe, expect, it } from 'bun:test'
import { BasePlugin, Plugin, withTestHost } from '@pluxel/core/test'

describe('EffectScopeService', () => {
	it('disposes collected effects when plugin is unloaded', async () => {
		let disposed = 0

		await withTestHost(async (host) => {
			@Plugin({ name: 'P' })
			class P extends BasePlugin {
				protected override init(_abort: AbortSignal) {
					this.ctx.collectEffect(() => {
						disposed++
					})
				}
			}

			await host.start(P)
			expect(disposed).toBe(0)

			host.unregister(P)
			await host.commit()
			expect(disposed).toBe(1)
		})
	})

	it('shutdown() throws outside plugin context', async () => {
		await withTestHost(async (host) => {
			expect(() => host.ctx.shutdown()).toThrow('not in a plugin context')
		})
	})
})
