import { pluginNodeAddressOf, pluginNodeIndexKey } from '@pluxel/core'
import { requireRuntimePluginGraphCoordinator, runtimeStatePatch } from '@pluxel/runtime/internal'
import { describe, expect, it } from 'vitest'
import { BasePlugin, createRuntimeContext, createRuntimeHost, Plugin } from '@pluxel/runtime/test'
import { lowerTestPlugin } from '../helpers/lowered-plugin'

describe('runtime/test host', () => {
	it('exposes explicit async disposal on both test resources', async () => {
		const host = createRuntimeHost()
		expect(host[Symbol.asyncDispose]).toBeTypeOf('function')
		await host[Symbol.asyncDispose]()

		const runtime = createRuntimeContext()
		expect(runtime[Symbol.asyncDispose]).toBeTypeOf('function')
		await runtime[Symbol.asyncDispose]()
	})

	it('keeps mutable PluginService authority off the normal runtime test host', async () => {
		const host = createRuntimeHost()
		try {
			expect('registry' in host).toBe(false)
		} finally {
			await host.dispose()
		}
	})

	it('surfaces a blocked cold boot as graph_rejected and recovers on the next catalog update', async () => {
		const host = createRuntimeHost()
		try {
			@Plugin({ displayName: 'LateDep' })
			class LateDep extends BasePlugin {}

			@Plugin({ displayName: 'BlockedConsumer' })
			class BlockedConsumer extends BasePlugin {
				constructor(readonly dep: LateDep) {
					super()
				}
			}
			lowerTestPlugin(LateDep)
			lowerTestPlugin(BlockedConsumer, { requires: [LateDep] })
			host.add(BlockedConsumer)
			host.cfg(BlockedConsumer).setAutoStart(true)
			host.start(BlockedConsumer)

			await expect(host.commit()).rejects.toMatchObject({
				name: 'PluginGraphRejectedError',
				code: 'graph_rejected',
				issues: [
					expect.objectContaining({
						kind: 'missing_required_provider',
					}),
				],
			})
			expect(host.isRunning(BlockedConsumer)).toBe(false)

			host.add(LateDep)
			host.cfg(LateDep).setAutoStart(true)
			host.start(LateDep)
			await host.commit()

			expect(host.require(BlockedConsumer).dep).toBeInstanceOf(LateDep)
		} finally {
			await host.dispose()
		}
	})

	it('starts plugins through the real runtime context', async () => {
		const host = createRuntimeHost()
		try {
			@Plugin({ displayName: 'Dep' })
			class Dep extends BasePlugin {}

			@Plugin({ displayName: 'Consumer' })
			class Consumer extends BasePlugin {
				constructor(readonly dep: Dep) {
					super()
				}
			}
			lowerTestPlugin(Dep)
			lowerTestPlugin(Consumer, { requires: [Dep] })
			host.add([Dep, Consumer])
			host.cfg(Dep).setAutoStart(true)
			host.start(Dep)
			host.cfg(Consumer).setAutoStart(true)
			host.start(Consumer)
			await host.commit()

			const consumer = host.require(Consumer)
			expect(consumer.dep).toBeInstanceOf(Dep)
			expect(host.require(Dep)).toBeInstanceOf(Dep)
			expect(host.isRunning(Dep)).toBe(true)
			expect(host.isRunning(Consumer)).toBe(true)
		} finally {
			await host.dispose()
		}
	})

	it('stages start, stop, and restart independently from durable auto-start policy', async () => {
		const host = createRuntimeHost()
		try {
			@Plugin({ displayName: 'SessionProvider' })
			class SessionProvider extends BasePlugin {}

			@Plugin({ displayName: 'SessionConsumer' })
			class SessionConsumer extends BasePlugin {
				constructor(readonly provider: SessionProvider) {
					super()
				}
			}
			lowerTestPlugin(SessionProvider)
			lowerTestPlugin(SessionConsumer, { requires: [SessionProvider] })

			host.add([SessionProvider, SessionConsumer])
			host.cfg(SessionConsumer).setAutoStart(true)
			host.start(SessionConsumer)
			await host.commit()

			const coordinator = requireRuntimePluginGraphCoordinator(host.ctx)
			const provider = pluginNodeAddressOf(SessionProvider)
			const providerKey = pluginNodeIndexKey(provider)
			expect(host.cfg(SessionProvider).autoStart()).toBe(false)
			expect(host.isRunning(SessionProvider)).toBe(true)
			expect(host.isRunning(SessionConsumer)).toBe(true)
			expect(coordinator.sessionIntentsSnapshot().has(providerKey)).toBe(false)
			expect(coordinator.desiredControlSnapshot().get(providerKey)?.activationReason).toBe(
				'dependency',
			)
			await coordinator.updateRuntimeState(
				runtimeStatePatch({ type: 'set-auto-start', node: provider, autoStart: false }),
				'test-idempotent-auto-start-off',
			)
			expect(coordinator.sessionIntentsSnapshot().has(providerKey)).toBe(false)
			expect(coordinator.desiredControlSnapshot().get(providerKey)?.activationReason).toBe(
				'dependency',
			)
			await coordinator.updateRuntimeState(
				runtimeStatePatch(
					{ type: 'set-auto-start', node: provider, autoStart: true },
					{ type: 'set-auto-start', node: provider, autoStart: false },
				),
				'test-net-noop-auto-start',
			)
			expect(coordinator.sessionIntentsSnapshot().has(providerKey)).toBe(false)
			expect(coordinator.desiredControlSnapshot().get(providerKey)?.activationReason).toBe(
				'dependency',
			)

			host.stop(SessionConsumer)
			await host.commit()
			expect(host.isRunning(SessionProvider)).toBe(false)
			expect(host.isRunning(SessionConsumer)).toBe(false)
			expect(coordinator.sessionIntentsSnapshot().has(providerKey)).toBe(false)
			host.start(SessionConsumer)
			await host.commit()
			expect(host.isRunning(SessionProvider)).toBe(true)
			expect(host.isRunning(SessionConsumer)).toBe(true)

			host.stop(SessionProvider)
			expect(host.isRunning(SessionProvider)).toBe(true)
			await host.commit()
			expect(host.isRunning(SessionProvider)).toBe(false)
			expect(host.isRunning(SessionConsumer)).toBe(false)
			expect(coordinator.sessionIntentsSnapshot().get(providerKey)?.intent).toBe('stop')

			host.start(SessionProvider)
			expect(host.isRunning(SessionProvider)).toBe(false)
			await host.commit()
			expect(host.isRunning(SessionProvider)).toBe(true)
			expect(host.isRunning(SessionConsumer)).toBe(true)
			expect(coordinator.sessionIntentsSnapshot().has(providerKey)).toBe(false)
			expect(host.cfg(SessionProvider).autoStart()).toBe(false)

			host.restart(SessionProvider)
			await host.commit()
			expect(host.isRunning(SessionProvider)).toBe(true)
			expect(host.isRunning(SessionConsumer)).toBe(true)
		} finally {
			await host.dispose()
		}
	})
})
