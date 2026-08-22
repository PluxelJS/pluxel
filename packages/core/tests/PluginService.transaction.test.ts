import { BasePlugin, Plugin, pluginNodeAddressOf, withCoreHost } from '@pluxel/core/test'
import { requirePluginService } from '@pluxel/core/internal'
import { describe, expect, it } from 'vitest'

@Plugin({ displayName: 'Transaction recovery' })
class TransactionRecoveryPlugin extends BasePlugin {}

type FaultInjectableRegistry = {
	executePreparedCommit: (
		action: unknown,
		meta: unknown,
		onPointOfNoReturn: () => void,
		confirmGraph: () => void,
	) => Promise<unknown>
}

describe('Core Plugin transaction fail-safe', () => {
	it('publishes graph confirmation synchronously once before lifecycle summary', async () => {
		await withCoreHost(async (host) => {
			const registry = requirePluginService(host.ctx)
			let confirmations = 0
			let published: unknown
			const unsubscribe = registry.subscribeCommitted((summary) => {
				published = summary
			})
			host.ctx.effects.defer(unsubscribe)
			host.add(TransactionRecoveryPlugin)
			await host.commit({
				onGraphCommitted: () => {
					confirmations++
					expect(registry.isMaterialized(pluginNodeAddressOf(TransactionRecoveryPlugin))).toBe(true)
					expect(registry.lastCommit).toBeUndefined()
				},
			})
			expect(confirmations).toBe(1)
			const summary = registry.lastCommit
			expect(summary).toBeDefined()
			expect(published).toBe(summary)
			expect(Object.hasOwn(summary!, 'graph')).toBe(false)
			expect(Object.keys(summary!)).toEqual(['pluginChanges', 'runtimeUpdate', 'lifecycleReport'])
			expect(Object.isFrozen(summary)).toBe(true)
			expect(Object.isFrozen(summary!.pluginChanges)).toBe(true)
			expect(Object.isFrozen(summary!.pluginChanges.added)).toBe(true)
			expect(Object.isFrozen(summary!.runtimeUpdate)).toBe(true)
			expect(Object.isFrozen(summary!.lifecycleReport)).toBe(true)
			expect(Object.isFrozen(summary!.lifecycleReport.issues)).toBe(true)
			expect(() => (summary!.pluginChanges.added as unknown as unknown[]).pop()).toThrow(TypeError)
		})
	})

	it('rolls back an unexpected pre-commit failure and admits the next transaction', async () => {
		await withCoreHost(async (host) => {
			const registry = requirePluginService(host.ctx) as unknown as FaultInjectableRegistry
			const execute = registry.executePreparedCommit
			registry.executePreparedCommit = async () => {
				throw new Error('injected pre-commit failure')
			}

			host.add(TransactionRecoveryPlugin)
			await expect(host.commit()).rejects.toThrow('injected pre-commit failure')
			expect(host.has(TransactionRecoveryPlugin)).toBe(false)

			registry.executePreparedCommit = execute
			host.add(TransactionRecoveryPlugin)
			await host.commit()
			expect(host.isRunning(TransactionRecoveryPlugin)).toBe(true)
		})
	})

	it('commits prepared facts after the point of no return and leaves a retryable node', async () => {
		await withCoreHost(async (host) => {
			const registry = requirePluginService(host.ctx) as unknown as FaultInjectableRegistry
			const execute = registry.executePreparedCommit
			registry.executePreparedCommit = async (_action, _meta, onPointOfNoReturn) => {
				onPointOfNoReturn()
				throw new Error('injected post-commit failure')
			}

			host.add(TransactionRecoveryPlugin)
			let confirmations = 0
			await expect(
				host.commit({
					onGraphCommitted: () => {
						confirmations++
					},
				}),
			).rejects.toThrow('injected post-commit failure')
			expect(confirmations).toBe(1)
			expect(host.has(TransactionRecoveryPlugin)).toBe(true)
			expect(host.isRunning(TransactionRecoveryPlugin)).toBe(false)

			registry.executePreparedCommit = execute
			await host.commit()
			expect(host.isRunning(TransactionRecoveryPlugin)).toBe(true)
		})
	})
})
