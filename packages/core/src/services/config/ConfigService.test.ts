import { describe, expect, it } from 'vitest'
import { BasePlugin, Plugin, withCoreHost } from '@pluxel/core/test'
import type { StandardSchemaV1 } from '@standard-schema/spec'

const ObjectSchema: StandardSchemaV1<unknown, { answer?: number }> = {
	'~standard': {
		version: 1,
		vendor: 'pluxel:test',
		validate: (value: unknown) => ({
			value:
				value && typeof value === 'object' && !Array.isArray(value)
					? (value as { answer?: number })
					: {},
		}),
	},
}

@Plugin({ displayName: 'P' })
class P extends BasePlugin {
	readonly config = this.configs.use(ObjectSchema)
}

describe('ConfigService', () => {
	it('injects one validated object config per Plugin node', async () => {
		await withCoreHost(async (host) => {
			host.cfg(P).set({ answer: 42 })
			await host.start(P)
			const plugin = host.require(P)
			expect(plugin.config.answer).toBe(42)
			expect(plugin.ctx.configService.getValidatedConfig<{ answer?: number }>().answer).toBe(42)
		})
	})

	it('does not bump revision for no-op patches or unsets', async () => {
		await withCoreHost(async (host) => {
			const handle = host.cfg(P)
			handle.set({ answer: 1 })
			const first = handle.rev()
			handle.set({ answer: 1 })
			expect(handle.rev()).toBe(first)
			handle.unset('_missing')
			expect(handle.rev()).toBe(first)
			handle.unset('answer')
			expect(handle.rev()).toBeGreaterThan(first)
		})
	})

	it('stores structured enable preferences without interpreting them', async () => {
		await withCoreHost(async (host) => {
			const handle = host.cfg(P)
			expect(handle.enabled()).toBe(false)
			handle.enable()
			expect(handle.enabled()).toBe(true)
			handle.disable()
			expect(handle.enabled()).toBe(false)
		})
	})
})
