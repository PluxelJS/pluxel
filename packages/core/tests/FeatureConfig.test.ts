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

describe('BaseFeature config composition', () => {
	it('namespaces feature config into host plugin configMap and injects values into the feature instance', async () => {
		await withTestHost(async (host) => {
			const FeatureSchema = { any: 'schema' } as any
			const TelemetrySchema = { any: 'telemetry' } as any

			class CacheFeature extends BaseFeature {
				static featureKey = 'cache'

				cfg = this.configs.use(FeatureSchema)
			}

			class TelemetryFeature extends BaseFeature {
				static featureKey = 'telemetry'

				cfg = this.configs.use(TelemetrySchema)
			}

			// In production/HMR, this is injected by configSourcePlugin.
			__registerConfigSchema__(CacheFeature, 'cfg', FeatureSchema)
			__registerConfigSchema__(TelemetryFeature, 'cfg', TelemetrySchema)

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
			expect(feature).toBeTruthy()
			expect((feature as any).cfg).toEqual({ ok: true })

			const telemetry = instance.features.get(TelemetryFeature)
			expect(telemetry).toBeTruthy()
			expect((telemetry as any).cfg).toEqual({ ok: false })
		})
	})
})
