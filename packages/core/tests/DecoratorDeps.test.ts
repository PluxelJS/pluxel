import { describe, expect, it } from 'bun:test'

import {
	BasePlugin,
	ForkablePlugin,
	Plugin,
	pluginMethodDecorator,
	setParamToken,
	withTestHost,
} from '@pluxel/core/test'

const UsePluginId = (token: any) =>
	// Small helper to validate "token -> resolved instance" behavior for decorators.
	// - When token is a base (alias) token, we should resolve the base provider.
	// - When token is a fork ctor, we should resolve that specific fork.
	pluginMethodDecorator(token, async function (_original, dep) {
		return dep.ctx.pluginInfo.id
	})

const CachedWithToken = (token: any) =>
	// Demo of a cross-plugin decorator that resolves its dependency by token,
	// not by consumer-defined property names (e.g. no `this.kv` convention).
	pluginMethodDecorator(token, async function (original, kv, key, ...args) {
		const cacheKey = `${String(key)}:${JSON.stringify(args)}`
		if (await (kv as any).has(cacheKey)) return await (kv as any).get(cacheKey)
		const value = await original.apply(this, args)
		await (kv as any).set(cacheKey, value)
		return value
	})

describe('Decorator-required plugin deps', () => {
	it('throws when a plugin uses a decorator but has no ctor dependency', async () => {
		await withTestHost(async (host) => {
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

			host.register(KvPlugin)
			expect(() => host.register(ConsumerMissing)).toThrow(/Missing constructor dependencies/)
		})
	})

	it('inherits required deps from base classes', async () => {
		await withTestHost(async (host) => {
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

			host.register(KvPlugin)
			expect(() => host.register(ChildMissing)).toThrow(/Missing constructor dependencies/)
		})
	})

	it('demonstrates a realistic Cached() usage (cross-plugin decorator)', async () => {
		await withTestHost(async (host) => {
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

			host.registerAll(KvPlugin, Foo)
			await host.commitStrict()

			const foo = host.getOrThrow(Foo) as Foo
			expect(await foo.getUser('u1')).toEqual({ id: 'u1' })
			expect(await foo.getUser('u1')).toEqual({ id: 'u1' })
			expect(fetchCalls).toBe(1)
		})
	})

	it('resolves base vs fork tokens correctly', async () => {
		await withTestHost(async (host) => {
			abstract class KvBase extends ForkablePlugin {}

			@Plugin(KvBase, { name: 'Kv' })
			class Kv extends KvBase {}

			host.register(Kv)
			const ForkA = host.registerFork(Kv, 'a')

			// Simulate "plugin-side exports": pre-bound decorators, no token passed by consumers.
			const UseBaseId = () => UsePluginId(KvBase)
			const UseForkAId = () => UsePluginId(ForkA as any)

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
			setParamToken(ConsumerForks, 1, ForkA as any)

			host.register(ConsumerForks)
			await host.commitStrict()

			const c = host.getOrThrow(ConsumerForks) as ConsumerForks
			expect(await c.baseId()).toBe('Kv')
			expect(await c.forkId()).toBe('Kv#a')
		})
	})
})
