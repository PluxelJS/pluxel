import { describe, expect, it } from 'bun:test'

import {
	__registerConfigSchema__,
	BaseFeature,
	BasePlugin,
	getPluginInfo,
	Plugin,
	UseFeature,
	withTestHost,
} from '@pluxel/core/test'
import type { StandardSchemaV1 } from '@standard-schema/spec'

const PassthroughSchema: StandardSchemaV1 = {
	'~standard': {
		version: 1,
		vendor: 'pluxel:test',
		validate: (value: unknown) => ({ value }),
	},
}

describe('BaseFeature config composition', () => {
	it('namespaces feature config into host plugin configMap and injects values into the feature instance', async () => {
		await withTestHost(async (host) => {
			class CacheFeature extends BaseFeature {
				static featureKey = 'cache'

				cfg = this.configs.use(PassthroughSchema)
			}

			class TelemetryFeature extends BaseFeature {
				static featureKey = 'telemetry'

				cfg = this.configs.use(PassthroughSchema)
			}

			// In production/HMR, this is injected by configSourcePlugin.
			__registerConfigSchema__(CacheFeature, 'cfg', PassthroughSchema)
			__registerConfigSchema__(TelemetryFeature, 'cfg', PassthroughSchema)

			@UseFeature(CacheFeature, TelemetryFeature)
			@Plugin({ name: 'Host' })
			class Host extends BasePlugin {
				feature = this.features.use(CacheFeature)
				telemetry = this.features.use(TelemetryFeature)
			}

			const info = getPluginInfo(Host)
			expect(info.configMap).not.toBeNull()
			expect(Object.keys(info.configMap ?? {})).toContain('cache.cfg')
			expect(Object.keys(info.configMap ?? {})).toContain('telemetry.cfg')

			host.setConfig(Host, { 'cache.cfg': { ok: true }, 'telemetry.cfg': { ok: false } })
			host.register(Host)
			await host.commitStrict()

			const instance = host.getOrThrow(Host) as Host
			const feature = instance.features.get(CacheFeature)
			expect(feature).toBeDefined()
			expect(feature?.cfg).toEqual({ ok: true })

			const telemetry = instance.features.get(TelemetryFeature)
			expect(telemetry).toBeDefined()
			expect(telemetry?.cfg).toEqual({ ok: false })
		})
	})
})
