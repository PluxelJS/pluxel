import { describe, expect, it } from 'vitest'
import type { PluginIdentifier } from '@pluxel/core'
import type {
	DepOptionalFeature,
	InlineOptionalFeature,
	HostBoundOptionalFeature,
} from './plugins/FeatureLoad.optional'

import {
	BaseFeature,
	BasePlugin,
	defineLazyFeature,
	Plugin,
	withCoreHost,
} from '@pluxel/core/test'

const loadLoads = {
	dep: 0,
	hostBound: 0,
	missingToken: 0,
}

@Plugin({ name: 'LoadDep' })
class LoadDep extends BasePlugin {}

const optionalDepFeature = defineLazyFeature({
	key: 'optional-dep',
	requires: [LoadDep],
	load: async () => {
		loadLoads.dep += 1
		const mod = await import('./plugins/FeatureLoad.optional')
		return mod.DepOptionalFeature
	},
})

@Plugin({ name: 'LoadHost' })
class LoadHost extends BasePlugin {
	feature?: DepOptionalFeature

	override async init(): Promise<void> {
		this.feature = await this.features.load(optionalDepFeature)
	}
}

const optionalHostFeature = defineLazyFeature({
	key: 'host-bound',
	load: async () => {
		loadLoads.hostBound += 1
		const mod = await import('./plugins/FeatureLoad.optional')
		return mod.HostBoundOptionalFeature
	},
})

@Plugin({ name: 'LoadHostBound' })
class LoadHostBound extends BasePlugin {
	first?: HostBoundOptionalFeature
	second?: HostBoundOptionalFeature

	override async init(): Promise<void> {
		const [first, second] = await Promise.all([
			this.features.load(optionalHostFeature),
			this.features.load(optionalHostFeature),
		])
		this.first = first
		this.second = second
	}
}

@Plugin({ name: 'LoadInlineSpec' })
class LoadInlineSpec extends BasePlugin {}

const missingProviderTokenFeature = defineLazyFeature({
	key: 'missing-provider-token',
	requires: ['pluxel.missing-provider' as unknown as PluginIdentifier],
	load: async () => {
		loadLoads.missingToken += 1
		const mod = await import('./plugins/FeatureLoad.optional')
		return mod.InlineOptionalFeature
	},
})

@Plugin({ name: 'LoadMissingProviderToken' })
class LoadMissingProviderToken extends BasePlugin {
	feature?: InlineOptionalFeature

	override async init(): Promise<void> {
		this.feature = await this.features.load(missingProviderTokenFeature)
	}
}

const legacyArgsFeature = defineLazyFeature({
	key: 'legacy-args',
	load: async () => {
		const mod = await import('./plugins/FeatureLoad.optional')
		return mod.InlineOptionalFeature
	},
})

@Plugin({ name: 'LoadArgs' })
class LoadArgs extends BasePlugin {}

const invalidOptionalFeature = defineLazyFeature({
	key: 'invalid-optional',
	load: async () => {
		const mod = await import('./plugins/FeatureLoad.optional')
		return mod.InvalidOptionalFeature
	},
})

@Plugin({ name: 'LoadInvalid' })
class LoadInvalid extends BasePlugin {
	feature?: BaseFeature

	override async init(): Promise<void> {
		this.feature = await this.features.load(invalidOptionalFeature)
	}
}

const featureA = defineLazyFeature({
	key: 'shared-key',
	load: async () => {
		const mod = await import('./plugins/FeatureLoad.optional')
		return mod.KeyFeatureA
	},
})

const featureB = defineLazyFeature({
	key: 'shared-key',
	load: async () => {
		const mod = await import('./plugins/FeatureLoad.optional')
		return mod.KeyFeatureB
	},
})

@Plugin({ name: 'LoadSpecMismatch' })
class LoadSpecMismatch extends BasePlugin {}

describe('FeatureHost.load', () => {
	it('skips lazy features until required runtime deps are available', async () => {
		await withCoreHost(async (host) => {
			const { DepOptionalFeature } = await import('./plugins/FeatureLoad.optional')
			DepOptionalFeature.reset()
			loadLoads.dep = 0

			host.add(LoadHost)
			await host.commit()

			let instance = host.require(LoadHost) as LoadHost
			expect(instance.feature).toBeUndefined()
			expect(loadLoads.dep).toBe(0)
			expect(DepOptionalFeature.initCount).toBe(0)

			host.add(LoadDep)
			host.restart(LoadHost)
			await host.commit()

			instance = host.require(LoadHost) as LoadHost
			expect(instance.feature).toBeInstanceOf(DepOptionalFeature)
			expect(loadLoads.dep).toBe(1)
			expect(DepOptionalFeature.initCount).toBe(1)
		})
	})

	it('loads once per key and supports host-bound lazy features', async () => {
		await withCoreHost(async (host) => {
			loadLoads.hostBound = 0

			host.add(LoadHostBound)
			await host.commit()

			const instance = host.require(LoadHostBound) as LoadHostBound
			const { HostBoundOptionalFeature } = await import('./plugins/FeatureLoad.optional')
			expect(loadLoads.hostBound).toBe(1)
			expect(instance.first).toBeInstanceOf(HostBoundOptionalFeature)
			expect(instance.first).toBe(instance.second)
			expect(instance.first?.hostPluginId()).toBe('LoadHostBound')
		})
	})

	it('skips before load when string-token optional deps are absent', async () => {
		await withCoreHost(async (host) => {
			loadLoads.missingToken = 0

			host.add(LoadMissingProviderToken)
			await host.commit()

			const instance = host.require(LoadMissingProviderToken) as LoadMissingProviderToken
			expect(instance.feature).toBeUndefined()
			expect(loadLoads.missingToken).toBe(0)
		})
	})

	it('requires defineLazyFeature() specs at runtime', async () => {
		await withCoreHost(async (host) => {
			host.add(LoadInlineSpec)
			await host.commit()

			const instance = host.require(LoadInlineSpec) as LoadInlineSpec
			expect(() =>
				(instance.features as unknown as { load: (spec: unknown) => unknown }).load({
					key: 'inline-optional',
					load: async () => {
						const mod = await import('./plugins/FeatureLoad.optional')
						return mod.InlineOptionalFeature
					},
				}),
			).toThrow(/defineLazyFeature/)
		})
	})

	it('rejects legacy load() constructor args at runtime', async () => {
		await withCoreHost(async (host) => {
			host.add(LoadArgs)
			await host.commit()

			const instance = host.require(LoadArgs) as LoadArgs
			expect(() =>
				(instance.features as unknown as { load: (...args: unknown[]) => unknown }).load(
					legacyArgsFeature,
					'legacy-arg',
				),
			).toThrow(/does not accept feature constructor args/)
		})
	})

	it('rejects declaration-time features from load()', async () => {
		await withCoreHost(async (host) => {
			host.add(LoadInvalid)
			await host.commit()

			const instance = host.require(LoadInvalid) as LoadInvalid
			const { InvalidOptionalFeature } = await import('./plugins/FeatureLoad.optional')
			expect(instance.feature).toBeUndefined()
			expect(instance.features.get(InvalidOptionalFeature)).toBeUndefined()
		})
	})

	it('rejects reusing one optional key with different specs', async () => {
		await withCoreHost(async (host) => {
			host.add(LoadSpecMismatch)
			await host.commit()

			const instance = host.require(LoadSpecMismatch) as LoadSpecMismatch
			await instance.features.load(featureA)

			expect(() =>
				instance.features.load(featureB),
			).toThrow(/reused with a different spec/)
		})
	})
})
