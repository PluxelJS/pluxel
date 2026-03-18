import { describe, expect, it } from 'vitest'
import { BasePlugin, Config, Plugin, withHost } from '@pluxel/test'
import type { StandardSchemaV1 } from '@standard-schema/spec'

const PassthroughSchema: StandardSchemaV1 = {
	'~standard': {
		version: 1,
		vendor: 'pluxel:test',
		validate: (value: unknown) => ({ value }),
	},
}

describe('ConfigService', () => {
	it('returns the per-plugin config snapshot in plugin context', async () => {
		await withHost(async (host) => {
			@Plugin({ name: 'P' })
			class P extends BasePlugin {
				@Config(PassthroughSchema)
				answer!: number
			}

			host.cfg(P).set({ answer: 42 })
			await host.start(P)

			const p = host.require(P)
			expect(p.answer).toBe(42)
			expect(p.ctx.configService.getValidatedConfig<{ answer?: number }>().answer).toBe(42)
		})
	})

	it('reuses the cached validated snapshot across schemaMap recreation', async () => {
		await withHost(async (host) => {
			host.ctx.configService.patchConfig('P', { answer: 1 })

			const first = await host.ctx.configService.ensureValidated('P', { answer: PassthroughSchema })
			const second = await host.ctx.configService.ensureValidated('P', {
				answer: PassthroughSchema,
			})

			expect(second).toBe(first)
		})
	})

	it('does not bump revision for no-op patches/unsets', async () => {
		await withHost(async (host) => {
			host.ctx.configService.patchConfig('P', { answer: 1 })
			const rev1 = host.ctx.configService.getConfigRevision('P')

			host.ctx.configService.patchConfig('P', { answer: 1 })
			expect(host.ctx.configService.getConfigRevision('P')).toBe(rev1)

			host.ctx.configService.unsetConfigKeys('P', ['_missing'])
			expect(host.ctx.configService.getConfigRevision('P')).toBe(rev1)

			host.ctx.configService.unsetConfigKeys('P', ['answer'])
			expect(host.ctx.configService.getConfigRevision('P')).toBeGreaterThan(rev1)
		})
	})

	it('stores enable/disable preferences without interpreting them', async () => {
		await withHost(async (host) => {
			expect(host.cfg('P').enabled()).toBe(false)

			host.cfg('P').enable()
			expect(host.cfg('P').enabled()).toBe(true)

			host.cfg('P').disable()
			expect(host.cfg('P').enabled()).toBe(false)
		})
	})
})
