import { describe, expect, it } from 'bun:test'
import { BasePlugin, Config, Plugin, withTestHost } from '@pluxel/core/test'

describe('ConfigService', () => {
	it('returns the per-plugin config snapshot in plugin context', async () => {
		await withTestHost(async (host) => {
			@Plugin({ name: 'P' })
			class P extends BasePlugin {
				@Config({})
				answer!: number
			}

			host.setConfig(P, { answer: 42 })
			await host.start(P)

			const p = host.getOrThrow(P)
			expect(p.answer).toBe(42)
			expect(p.ctx.configService.getConfig<{ answer?: number }>().answer).toBe(42)
		})
	})

	it('stores enable/disable preferences without interpreting them', async () => {
		await withTestHost(async (host) => {
			expect(host.isEnabled('P')).toBe(false)

			host.enablePlugins('P')
			expect(host.isEnabled('P')).toBe(true)

			host.disablePlugins('P')
			expect(host.isEnabled('P')).toBe(false)
		})
	})
})
