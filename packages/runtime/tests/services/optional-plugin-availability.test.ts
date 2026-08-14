import { describe, expect, it, vi } from 'vitest'
import { BasePlugin, createRuntimeHost, optionalPlugin, Plugin } from '@pluxel/runtime/test'

describe('optional plugin availability', () => {
	it('loads after the consumer commit and binds through the normal running watcher', async () => {
		const host = createRuntimeHost({ workbench: false })
		try {
			@Plugin({ name: 'OptionalProvider' })
			class OptionalProvider extends BasePlugin {
				value = 42
			}

			let loads = 0
			const Provider = optionalPlugin(async () => {
				loads++
				return OptionalProvider
			})

			@Plugin({ name: 'OptionalConsumer' })
			class OptionalConsumer extends BasePlugin {
				seen: number[] = []
				cleanups = 0

				override init(): void {
					this.plugins.use(Provider, (provider) => {
						this.seen.push(provider.value)
						return () => {
							this.cleanups++
						}
					})
				}
			}

			host.add(OptionalConsumer)
			host.cfg(OptionalConsumer).enable()
			await host.commit()

			const consumer = host.require(OptionalConsumer)
			await vi.waitFor(() => expect(consumer.seen).toEqual([42]))
			expect(loads).toBe(1)
			expect(host.isRunning(OptionalProvider)).toBe(true)

			host.remove(OptionalProvider)
			await host.commit()
			expect(consumer.cleanups).toBe(1)
		} finally {
			await host.dispose()
		}
	})

	it('deduplicates one reference across consumers', async () => {
		const host = createRuntimeHost({ workbench: false })
		try {
			@Plugin({ name: 'SharedOptionalProvider' })
			class SharedOptionalProvider extends BasePlugin {}

			let loads = 0
			const Provider = optionalPlugin(async () => {
				loads++
				return SharedOptionalProvider
			})

			const seen: string[] = []
			@Plugin({ name: 'OptionalConsumerA' })
			class OptionalConsumerA extends BasePlugin {
				override init(): void {
					this.plugins.use(Provider, () => void seen.push('a'))
				}
			}
			@Plugin({ name: 'OptionalConsumerB' })
			class OptionalConsumerB extends BasePlugin {
				override init(): void {
					this.plugins.use(Provider, () => void seen.push('b'))
				}
			}

			host.add([OptionalConsumerA, OptionalConsumerB])
			host.cfg(OptionalConsumerA).enable()
			host.cfg(OptionalConsumerB).enable()
			await host.commit()

			await vi.waitFor(() => expect(seen.sort()).toEqual(['a', 'b']))
			expect(loads).toBe(1)
		} finally {
			await host.dispose()
		}
	})

	it('treats an absent candidate as availability without failing the consumer', async () => {
		const host = createRuntimeHost({ workbench: false })
		try {
			@Plugin({ name: 'AbsentProvider' })
			class AbsentProvider extends BasePlugin {}
			let loads = 0
			const Provider = optionalPlugin<typeof AbsentProvider>(async () => {
				loads++
				throw Object.assign(new Error('not installed'), {
					code: 'PLUXEL_OPTIONAL_PLUGIN_ABSENT',
				})
			})

			@Plugin({ name: 'AbsentConsumer' })
			class AbsentConsumer extends BasePlugin {
				seen = 0
				override init(): void {
					this.plugins.use(Provider, () => void this.seen++)
				}
			}

			host.add(AbsentConsumer)
			host.cfg(AbsentConsumer).enable()
			await host.commit()
			await vi.waitFor(() => expect(loads).toBe(1))
			expect(host.isRunning(AbsentConsumer)).toBe(true)
			expect(host.require(AbsentConsumer).seen).toBe(0)
		} finally {
			await host.dispose()
		}
	})

	it('reports provider start failure without changing consumer lifecycle', async () => {
		const host = createRuntimeHost({ workbench: false })
		try {
			let shouldFail = true
			@Plugin({ name: 'BrokenOptionalProvider' })
			class BrokenOptionalProvider extends BasePlugin {
				override init(): void {
					if (shouldFail) throw new Error('provider boom')
				}
			}
			const Provider = optionalPlugin(async () => BrokenOptionalProvider)

			@Plugin({ name: 'BrokenOptionalConsumer' })
			class BrokenOptionalConsumer extends BasePlugin {
				seen = 0
				override init(): void {
					this.plugins.use(Provider, () => void this.seen++)
				}
			}

			host.add(BrokenOptionalConsumer)
			host.cfg(BrokenOptionalConsumer).enable()
			await host.commit()
			await vi.waitFor(() =>
				expect(host.ctx.registry.isRegistered(BrokenOptionalProvider)).toBe(true),
			)
			expect(host.isRunning(BrokenOptionalConsumer)).toBe(true)
			expect(host.isRunning(BrokenOptionalProvider)).toBe(false)

			shouldFail = false
			host.ctx.root.optionalPlugins.invalidate(Provider)
			await vi.waitFor(() => expect(host.isRunning(BrokenOptionalProvider)).toBe(true))
			expect(host.require(BrokenOptionalConsumer).seen).toBe(1)
		} finally {
			await host.dispose()
		}
	})

	it('honors persisted disabled state after a candidate is known', async () => {
		const host = createRuntimeHost({
			workbench: false,
			runtimeState: {
				mode: 'memory',
				snapshot: {
					enabled: ['DisabledOptionalConsumer'],
					optionalKnown: { DisabledOptionalProvider: 1 },
				},
			},
		})
		try {
			@Plugin({ name: 'DisabledOptionalProvider' })
			class DisabledOptionalProvider extends BasePlugin {}
			let loads = 0
			const Provider = optionalPlugin(async () => {
				loads++
				return DisabledOptionalProvider
			})

			@Plugin({ name: 'DisabledOptionalConsumer' })
			class DisabledOptionalConsumer extends BasePlugin {
				seen = 0
				override init(): void {
					this.plugins.use(Provider, () => void this.seen++)
				}
			}

			host.add(DisabledOptionalConsumer)
			await host.commit()
			await vi.waitFor(() => expect(loads).toBe(1))
			expect(host.require(DisabledOptionalConsumer).seen).toBe(0)
			expect(host.isRunning(DisabledOptionalProvider)).toBe(false)
		} finally {
			await host.dispose()
		}
	})

	it('replaces a provider through its synthetic module owner', async () => {
		const host = createRuntimeHost({ workbench: false })
		try {
			@Plugin({ name: 'ReplaceableOptionalProvider' })
			class ProviderV1 extends BasePlugin {
				version = 1
			}
			@Plugin({ name: 'ReplaceableOptionalProvider' })
			class ProviderV2 extends BasePlugin {
				version = 2
			}
			const ProviderRefV1 = optionalPlugin(async () => ProviderV1)
			const ProviderRefV2 = optionalPlugin(async () => ProviderV2)

			const seen: number[] = []
			let cleanups = 0
			@Plugin({ name: 'ReplaceableOptionalConsumer' })
			class ConsumerV1 extends BasePlugin {
				override init(): void {
					this.plugins.use(ProviderRefV1, (provider) => {
						seen.push(provider.version)
						return () => void cleanups++
					})
				}
			}
			@Plugin({ name: 'ReplaceableOptionalConsumer' })
			class ConsumerV2 extends BasePlugin {
				override init(): void {
					this.plugins.use(ProviderRefV2, (provider) => {
						seen.push(provider.version)
						return () => void cleanups++
					})
				}
			}

			host.add(ConsumerV1)
			host.cfg(ConsumerV1).enable()
			await host.commit()
			await vi.waitFor(() => expect(seen).toEqual([1]))

			host.replace(ConsumerV1, ConsumerV2)
			await host.commit()
			await vi.waitFor(() => expect(seen).toEqual([1, 2]))
			expect(host.isRunning(ProviderV2)).toBe(true)
			expect(cleanups).toBeGreaterThanOrEqual(1)
		} finally {
			await host.dispose()
		}
	})
})
