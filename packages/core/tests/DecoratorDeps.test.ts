import { describe, expect, it } from 'vitest'

import {
	BaseFeature,
	BasePlugin,
	ForkablePlugin,
	Plugin,
	setParamToken,
	withHost,
} from '@pluxel/test'
import { __registerUsedFeature__, pluginMethodDecorator } from '@pluxel/test/unsafe'

type PluginToken<T extends BasePlugin = BasePlugin> = abstract new (...args: unknown[]) => T
type KvLike = {
	has: (key: string) => Promise<boolean>
	get: (key: string) => Promise<unknown>
	set: (key: string, value: unknown) => Promise<void>
}

const UsePluginId = <T extends BasePlugin>(token: PluginToken<T>) =>
	// Small helper to validate "token -> resolved instance" behavior for decorators.
	// - When token is a base (alias) token, we should resolve the base provider.
	// - When token is a fork ctor, we should resolve that specific fork.
	pluginMethodDecorator(token, async (_original, dep) => dep.ctx.pluginInfo.id)

const CachedWithToken = <T extends BasePlugin>(token: PluginToken<T>) =>
	// Demo of a cross-plugin decorator that resolves its dependency by token,
	// not by consumer-defined property names (e.g. no `this.kv` convention).
	pluginMethodDecorator(token, async function (original, kv, key, ...args) {
		const kvLike = kv as unknown as KvLike
		const cacheKey = `${String(key)}:${JSON.stringify(args)}`
		if (await kvLike.has(cacheKey)) return await kvLike.get(cacheKey)
		const value = await original.apply(this, args)
		await kvLike.set(cacheKey, value)
		return value
	})

@Plugin({ name: 'FeatureDepsKvPlugin' })
class FeatureDepsKvPlugin extends BasePlugin {
	private store = new Map<string, unknown>()
	async has(key: string) {
		return this.store.has(key)
	}
	async get(key: string) {
		return this.store.get(key)
	}
	async set(key: string, value: unknown) {
		this.store.set(key, value)
	}
}

const FeatureDepsCached = () => CachedWithToken(FeatureDepsKvPlugin)

class FeatureDepsCacheFeature extends BaseFeature {
	@FeatureDepsCached()
	async compute(key: string) {
		return { key }
	}
}

@Plugin({ name: 'FeatureDepsConsumerMissing' })
class FeatureDepsConsumerMissing extends BasePlugin {
	readonly cache = this.features.use(FeatureDepsCacheFeature)
	async run() {
		return await this.cache.compute('x')
	}
}

@Plugin({ name: 'FeatureDepsConsumerOk' })
class FeatureDepsConsumerOk extends BasePlugin {
	readonly cache = this.features.use(FeatureDepsCacheFeature)
	constructor(public kv: FeatureDepsKvPlugin) {
		super()
	}
	async run() {
		return await this.cache.compute('x')
	}
}

__registerUsedFeature__(FeatureDepsConsumerMissing, FeatureDepsCacheFeature)
__registerUsedFeature__(FeatureDepsConsumerOk, FeatureDepsCacheFeature)
setParamToken(FeatureDepsConsumerOk, 0, FeatureDepsKvPlugin)

describe('Decorator-required plugin deps', () => {
	it('throws when a plugin uses a decorator but has no ctor dependency', async () => {
		await withHost(async (host) => {
			@Plugin({ name: 'KvPlugin' })
			class KvPlugin extends BasePlugin {}

			const RequiresKv = () => UsePluginId(KvPlugin)

			@Plugin({ name: 'ConsumerMissing' })
			class ConsumerMissing extends BasePlugin {
				@RequiresKv()
				async id() {
					return 'local'
				}
			}

			host.add(KvPlugin)
			expect(() => host.add(ConsumerMissing)).toThrow(/Missing constructor dependencies/)
		})
	})

	it('inherits required deps from base classes', async () => {
		await withHost(async (host) => {
			@Plugin({ name: 'KvPlugin' })
			class KvPlugin extends BasePlugin {}

			const RequiresKv = () => UsePluginId(KvPlugin)

			class Base extends BasePlugin {
				@RequiresKv()
				async id() {
					return 'local'
				}
			}

			@Plugin({ name: 'ChildMissing' })
			class ChildMissing extends Base {}

			host.add(KvPlugin)
			expect(() => host.add(ChildMissing)).toThrow(/Missing constructor dependencies/)
		})
	})

	it('demonstrates a realistic Cached() usage (cross-plugin decorator)', async () => {
		await withHost(async (host) => {
			@Plugin({ name: 'KvPlugin' })
			class KvPlugin extends BasePlugin {
				private store = new Map<string, unknown>()
				async has(key: string) {
					return this.store.has(key)
				}
				async get(key: string) {
					return this.store.get(key)
				}
				async set(key: string, value: unknown) {
					this.store.set(key, value)
				}
			}

			// Simulate "a decorator exported by the dependency plugin package".
			// Consumer does NOT pass token at usage sites; the plugin package binds it.
			const Cached = () => CachedWithToken(KvPlugin)

			let fetchCalls = 0

			@Plugin({ name: 'Foo' })
			class Foo extends BasePlugin {
				constructor(public kv: KvPlugin) {
					super()
				}

				@Cached()
				async getUser(id: string) {
					fetchCalls++
					return { id }
				}
			}
			setParamToken(Foo, 0, KvPlugin)

			host.add([KvPlugin, Foo])
			await host.commit()

			const foo = host.require(Foo) as Foo
			expect(await foo.getUser('u1')).toEqual({ id: 'u1' })
			expect(await foo.getUser('u1')).toEqual({ id: 'u1' })
			expect(fetchCalls).toBe(1)
		})
	})

	it('propagates decorator-required deps from BaseFeature via features.use() (extraction equivalent)', async () => {
		await withHost(async (host) => {
			host.add(FeatureDepsKvPlugin)
			expect(() => host.add(FeatureDepsConsumerMissing)).toThrow(/Missing constructor dependencies/)

			host.add(FeatureDepsConsumerOk)
			await host.commit()

			const consumer = host.require(FeatureDepsConsumerOk) as FeatureDepsConsumerOk
			expect(await consumer.run()).toEqual({ key: 'x' })
		})
	})

	it('resolves base vs fork tokens correctly', async () => {
		await withHost(async (host) => {
			abstract class KvBase extends ForkablePlugin {}

			@Plugin(KvBase, { name: 'Kv' })
			class Kv extends KvBase {}

			host.add(Kv)
			const ForkA = host.fork(Kv, 'a')

			// Simulate "plugin-side exports": pre-bound decorators, no token passed by consumers.
			const UseBaseId = () => UsePluginId(KvBase)
			const UseForkAId = () => UsePluginId(ForkA as unknown as PluginToken<KvBase>)

			@Plugin({ name: 'ConsumerForks' })
			class ConsumerForks extends BasePlugin {
				constructor(_base: KvBase, _fork: KvBase) {
					super()
				}

				@UseBaseId()
				async baseId() {
					return 'local'
				}

				@UseForkAId()
				async forkId() {
					return 'local'
				}
			}

			setParamToken(ConsumerForks, 0, KvBase)
			setParamToken(ConsumerForks, 1, ForkA as unknown as PluginToken<KvBase>)

			host.add(ConsumerForks)
			await host.commit()

			const c = host.require(ConsumerForks) as ConsumerForks
			expect(await c.baseId()).toBe('Kv')
			expect(await c.forkId()).toBe('Kv#a')
		})
	})
})
