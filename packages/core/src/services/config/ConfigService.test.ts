import { describe, expect, it } from 'bun:test'
import { BasePlugin, Config, Plugin, withTestHost } from '@pluxel/core/test'
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
		await withTestHost(async (host) => {
			@Plugin({ name: 'P' })
			class P extends BasePlugin {
				@Config(PassthroughSchema)
				answer!: number
			}

			host.setConfig(P, { answer: 42 })
			await host.start(P)

			const p = host.getOrThrow(P)
			expect(p.answer).toBe(42)
			expect(p.ctx.configService.getValidatedConfig<{ answer?: number }>().answer).toBe(42)
		})
	})

	it('reuses the cached validated snapshot across schemaMap recreation', async () => {
		await withTestHost(async (host) => {
			host.config.patchConfig('P', { answer: 1 })

			const first = await host.config.ensureValidated('P', { answer: PassthroughSchema })
			const second = await host.config.ensureValidated('P', { answer: PassthroughSchema })

			expect(second).toBe(first)
		})
	})

	it('does not bump revision for no-op patches/unsets', async () => {
		await withTestHost(async (host) => {
			host.config.patchConfig('P', { answer: 1 })
			const rev1 = host.config.getConfigRevision('P')

			host.config.patchConfig('P', { answer: 1 })
			expect(host.config.getConfigRevision('P')).toBe(rev1)

			host.config.unsetConfigKeys('P', ['_missing'])
			expect(host.config.getConfigRevision('P')).toBe(rev1)

			host.config.unsetConfigKeys('P', ['answer'])
			expect(host.config.getConfigRevision('P')).toBeGreaterThan(rev1)
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
