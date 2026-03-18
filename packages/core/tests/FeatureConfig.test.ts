import { describe, expect, it } from 'vitest'

import { BaseFeature, BasePlugin, getPluginInfo, Plugin, UseFeature, withHost } from '@pluxel/test'
import type { StandardSchemaV1 } from '@standard-schema/spec'

const PassthroughSchema: StandardSchemaV1 = {
	'~standard': {
		version: 1,
		vendor: 'pluxel:test',
		validate: (value: unknown) => ({ value }),
	},
}

class CacheFeature extends BaseFeature {
	static featureKey = 'cache'

	cfg = this.configs.use(PassthroughSchema)
}

class TelemetryFeature extends BaseFeature {
	static featureKey = 'telemetry'

	cfg = this.configs.use(PassthroughSchema)
}

@UseFeature(CacheFeature, TelemetryFeature)
@Plugin({ name: 'Host' })
class Host extends BasePlugin {
	feature = this.features.use(CacheFeature)
	telemetry = this.features.use(TelemetryFeature)
}

describe('BaseFeature config composition', () => {
	it('namespaces feature config into host plugin configMap and injects values into the feature instance', async () => {
		await withHost(async (host) => {
			const info = getPluginInfo(Host)
			expect(info.configMap).not.toBeNull()
			expect(Object.keys(info.configMap ?? {})).toContain('cache.cfg')
			expect(Object.keys(info.configMap ?? {})).toContain('telemetry.cfg')

			host.cfg(Host).set({ 'cache.cfg': { ok: true }, 'telemetry.cfg': { ok: false } })
			host.add(Host)
			await host.commit()

			const instance = host.require(Host) as Host
			const feature = instance.features.get(CacheFeature)
			expect(feature).toBeDefined()
			expect(feature?.cfg).toEqual({ ok: true })

			const telemetry = instance.features.get(TelemetryFeature)
			expect(telemetry).toBeDefined()
			expect(telemetry?.cfg).toEqual({ ok: false })
		})
	})
})
