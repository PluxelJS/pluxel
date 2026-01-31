import { describe, expect, it } from 'vitest'
import { BasePlugin, Plugin, withHost } from '@pluxel/test'

describe('EffectScopeService', () => {
	it('disposes collected effects when plugin is unloaded', async () => {
		let disposed = 0

		await withHost(async (host) => {
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

			host.remove(P)
			await host.commit()
			expect(disposed).toBe(1)
		})
	})

	it('shutdown() throws outside plugin context', async () => {
		await withHost(async (host) => {
			expect(() => host.ctx.shutdown()).toThrow('not in a plugin context')
		})
	})
})
