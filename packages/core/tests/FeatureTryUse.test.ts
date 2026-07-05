import { describe, expect, it } from 'vitest'
import type { PluginIdentifier } from '@pluxel/core'
import type {
	DepOptionalFeature,
	InlineOptionalFeature,
	HostBoundOptionalFeature,
} from './plugins/FeatureTryUse.optional'

import {
	BaseFeature,
	BasePlugin,
	defineOptionalFeature,
	Plugin,
	withCoreHost,
} from '@pluxel/core/test'

const tryUseLoads = {
	dep: 0,
	hostBound: 0,
	missingToken: 0,
}

@Plugin({ name: 'TryUseDep' })
class TryUseDep extends BasePlugin {}

const optionalDepFeature = defineOptionalFeature({
	key: 'optional-dep',
	requires: [TryUseDep],
	load: async () => {
		tryUseLoads.dep += 1
		const mod = await import('./plugins/FeatureTryUse.optional')
		return mod.DepOptionalFeature
	},
})

@Plugin({ name: 'TryUseHost' })
class TryUseHost extends BasePlugin {
	feature?: DepOptionalFeature

	override async init(): Promise<void> {
		this.feature = await this.features.tryUse(optionalDepFeature)
	}
}

const optionalHostFeature = defineOptionalFeature({
	key: 'host-bound',
	load: async () => {
		tryUseLoads.hostBound += 1
		const mod = await import('./plugins/FeatureTryUse.optional')
		return mod.HostBoundOptionalFeature
	},
})

@Plugin({ name: 'TryUseHostBound' })
class TryUseHostBound extends BasePlugin {
	first?: HostBoundOptionalFeature
	second?: HostBoundOptionalFeature

	override async init(): Promise<void> {
		const [first, second] = await Promise.all([
			this.features.tryUse(optionalHostFeature),
			this.features.tryUse(optionalHostFeature),
		])
		this.first = first
		this.second = second
	}
}

@Plugin({ name: 'TryUseInlineSpec' })
class TryUseInlineSpec extends BasePlugin {}

const missingProviderTokenFeature = defineOptionalFeature({
	key: 'missing-provider-token',
	requires: ['pluxel.missing-provider' as unknown as PluginIdentifier],
	load: async () => {
		tryUseLoads.missingToken += 1
		const mod = await import('./plugins/FeatureTryUse.optional')
		return mod.InlineOptionalFeature
	},
})

@Plugin({ name: 'TryUseMissingProviderToken' })
class TryUseMissingProviderToken extends BasePlugin {
	feature?: InlineOptionalFeature

	override async init(): Promise<void> {
		this.feature = await this.features.tryUse(missingProviderTokenFeature)
	}
}

const legacyArgsFeature = defineOptionalFeature({
	key: 'legacy-args',
	load: async () => {
		const mod = await import('./plugins/FeatureTryUse.optional')
		return mod.InlineOptionalFeature
	},
})

@Plugin({ name: 'TryUseArgs' })
class TryUseArgs extends BasePlugin {}

const invalidOptionalFeature = defineOptionalFeature({
	key: 'invalid-optional',
	load: async () => {
		const mod = await import('./plugins/FeatureTryUse.optional')
		return mod.InvalidOptionalFeature
	},
})

@Plugin({ name: 'TryUseInvalid' })
class TryUseInvalid extends BasePlugin {
	feature?: BaseFeature

	override async init(): Promise<void> {
		this.feature = await this.features.tryUse(invalidOptionalFeature)
	}
}

const featureA = defineOptionalFeature({
	key: 'shared-key',
	load: async () => {
		const mod = await import('./plugins/FeatureTryUse.optional')
		return mod.KeyFeatureA
	},
})

const featureB = defineOptionalFeature({
	key: 'shared-key',
	load: async () => {
		const mod = await import('./plugins/FeatureTryUse.optional')
		return mod.KeyFeatureB
	},
})

@Plugin({ name: 'TryUseSpecMismatch' })
class TryUseSpecMismatch extends BasePlugin {}

describe('FeatureHost.tryUse', () => {
	it('skips optional features until required runtime deps are available', async () => {
		await withCoreHost(async (host) => {
			const { DepOptionalFeature } = await import('./plugins/FeatureTryUse.optional')
			DepOptionalFeature.reset()
			tryUseLoads.dep = 0

			host.add(TryUseHost)
			await host.commit()

			let instance = host.require(TryUseHost) as TryUseHost
			expect(instance.feature).toBeUndefined()
			expect(tryUseLoads.dep).toBe(0)
			expect(DepOptionalFeature.initCount).toBe(0)

			host.add(TryUseDep)
			host.restart(TryUseHost)
			await host.commit()

			instance = host.require(TryUseHost) as TryUseHost
			expect(instance.feature).toBeInstanceOf(DepOptionalFeature)
			expect(tryUseLoads.dep).toBe(1)
			expect(DepOptionalFeature.initCount).toBe(1)
		})
	})

	it('loads once per key and supports host-bound optional features', async () => {
		await withCoreHost(async (host) => {
			tryUseLoads.hostBound = 0

			host.add(TryUseHostBound)
			await host.commit()

			const instance = host.require(TryUseHostBound) as TryUseHostBound
			const { HostBoundOptionalFeature } = await import('./plugins/FeatureTryUse.optional')
			expect(tryUseLoads.hostBound).toBe(1)
			expect(instance.first).toBeInstanceOf(HostBoundOptionalFeature)
			expect(instance.first).toBe(instance.second)
			expect(instance.first?.hostPluginId()).toBe('TryUseHostBound')
		})
	})

	it('skips before load when string-token optional deps are absent', async () => {
		await withCoreHost(async (host) => {
			tryUseLoads.missingToken = 0

			host.add(TryUseMissingProviderToken)
			await host.commit()

			const instance = host.require(TryUseMissingProviderToken) as TryUseMissingProviderToken
			expect(instance.feature).toBeUndefined()
			expect(tryUseLoads.missingToken).toBe(0)
		})
	})

	it('requires defineOptionalFeature() specs at runtime', async () => {
		await withCoreHost(async (host) => {
			host.add(TryUseInlineSpec)
			await host.commit()

			const instance = host.require(TryUseInlineSpec) as TryUseInlineSpec
			expect(() =>
				(instance.features as unknown as { tryUse: (spec: unknown) => unknown }).tryUse({
					key: 'inline-optional',
					load: async () => {
						const mod = await import('./plugins/FeatureTryUse.optional')
						return mod.InlineOptionalFeature
					},
				}),
			).toThrow(/defineOptionalFeature/)
		})
	})

	it('rejects legacy tryUse() constructor args at runtime', async () => {
		await withCoreHost(async (host) => {
			host.add(TryUseArgs)
			await host.commit()

			const instance = host.require(TryUseArgs) as TryUseArgs
			expect(() =>
				(instance.features as unknown as { tryUse: (...args: unknown[]) => unknown }).tryUse(
					legacyArgsFeature,
					'legacy-arg',
				),
			).toThrow(/does not accept feature constructor args/)
		})
	})

	it('rejects declaration-time features from tryUse()', async () => {
		await withCoreHost(async (host) => {
			host.add(TryUseInvalid)
			await host.commit()

			const instance = host.require(TryUseInvalid) as TryUseInvalid
			const { InvalidOptionalFeature } = await import('./plugins/FeatureTryUse.optional')
			expect(instance.feature).toBeUndefined()
			expect(instance.features.get(InvalidOptionalFeature)).toBeUndefined()
		})
	})

	it('rejects reusing one optional key with different specs', async () => {
		await withCoreHost(async (host) => {
			host.add(TryUseSpecMismatch)
			await host.commit()

			const instance = host.require(TryUseSpecMismatch) as TryUseSpecMismatch
			await instance.features.tryUse(featureA)

			expect(() =>
				instance.features.tryUse(featureB),
			).toThrow(/reused with a different spec/)
		})
	})
})
