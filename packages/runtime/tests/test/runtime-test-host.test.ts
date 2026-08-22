import { describe, expect, it } from 'vitest'
import { BasePlugin, createRuntimeHost, Plugin } from '@pluxel/runtime/test'
import { lowerTestPlugin } from '../helpers/lowered-plugin'

describe('runtime/test host', () => {
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
			host.cfg(BlockedConsumer).enable()

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
			host.cfg(LateDep).enable()
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
			host.cfg(Dep).enable()
			host.cfg(Consumer).enable()
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
})
