import { describe, expect, it } from 'bun:test'
import { BasePlugin, Plugin, withTestHost } from '@pluxel/core/test'

describe('EventsService', () => {
	it('auto-unsubscribes listeners when plugin is unloaded', async () => {
		await withTestHost(async (host) => {
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
			const p = host.getOrThrow(P)

			host.ctx.emit('onLoad', 'a')
			expect(p.seen).toEqual(['a'])

			host.unregister(P)
			await host.commit()

			host.ctx.emit('onLoad', 'b')
			expect(p.seen).toEqual(['a'])
		})
	})
})
