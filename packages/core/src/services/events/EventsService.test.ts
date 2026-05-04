import { describe, expect, it } from 'vitest'
import { BasePlugin, Plugin, withCoreHost } from '@pluxel/core/test'

describe('EventsService', () => {
	it('auto-unsubscribes listeners when plugin is unloaded', async () => {
		await withCoreHost(async (host) => {
			@Plugin({ name: 'P' })
			class P extends BasePlugin {
				seen: string[] = []
				protected override init(_abort: AbortSignal) {
					this.ctx.on('onLoad', (name) => {
						this.seen.push(name)
					})
				}
			}

			await host.start(P)
			const p = host.require(P)

			host.ctx.emit('onLoad', 'a')
			expect(p.seen).toEqual(['a'])

			host.remove(P)
			await host.commit()

			host.ctx.emit('onLoad', 'b')
			expect(p.seen).toEqual(['a'])
		})
	})
})
