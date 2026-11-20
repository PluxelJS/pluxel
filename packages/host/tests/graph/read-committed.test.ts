import { candidate, memoryStateStore, state } from './coordinator-fixture'
import {
	pluginNodeIndexKey,
	type PluginDefinitionAddress,
	type PluginNodeAddress,
} from '@pluxel/core'
import {
	createPluginCatalogSnapshot,
	hostStatePatch,
	PluginHostCoordinator,
	type CorePluginDependencyAdjacency,
	type CorePluginGraphDriver,
} from '@pluxel/host/internal'
import { describe, expect, it, vi } from 'vitest'

describe('PluginHostCoordinator committed reads', () => {
	it('waits across persistence, Core publication, and lifecycle settlement barriers', async () => {
		const Provider = definition('BarrierProvider')
		const provider = node(Provider)
		const persistenceEntered = deferred<void>()
		const releasePersistence = deferred<void>()
		const graphPublished = deferred<void>()
		const releaseLifecycle = deferred<void>()
		const store = memoryStateStore(state(), async () => {
			persistenceEntered.resolve()
			await releasePersistence.promise
		})
		let committedAdjacency: CorePluginDependencyAdjacency = emptyAdjacency()
		let running = false
		const core: CorePluginGraphDriver<string> = {
			readCommittedDependencyAdjacency: () => committedAdjacency,
			isRunning: (address) =>
				running && pluginNodeIndexKey(address) === pluginNodeIndexKey(provider),
			beginUpdate: () => {
				const materialized: PluginNodeAddress[] = []
				return {
					materializeNode: (address) => materialized.push(address),
					dematerializeNode() {},
					restartNode() {},
					replaceDefinition() {},
					setProviderDefault() {},
					setDependencyOverride() {},
					prepare: () => ({
						commit: async ({ onGraphCommitted }) => {
							committedAdjacency = Object.freeze({
								nodes: Object.freeze([...materialized]),
								required: Object.freeze([]),
								optional: Object.freeze([]),
							})
							onGraphCommitted()
							graphPublished.resolve()
							await releaseLifecycle.promise
							running = true
							return 'committed'
						},
						rollback() {},
					}),
					rollback() {},
				}
			},
		}
		const coordinator = new PluginHostCoordinator(store, core)
		const update = coordinator.update({
			catalog: createPluginCatalogSnapshot(1, [{ candidate: candidate(Provider) }]),
			statePatch: hostStatePatch({ type: 'set-auto-start', node: provider, autoStart: true }),
			mode: 'cold-boot',
		})
		await persistenceEntered.promise

		const callback = vi.fn((view) => ({
			catalogRevision: view.catalog.revision,
			stateRevision: view.runtimeState.revision,
			applied: [...view.applied.nodes.keys()],
			core: view.coreAdjacency.nodes.map(pluginNodeIndexKey),
			running: view.runningNodes.map(pluginNodeIndexKey),
		}))
		const read = coordinator.readCommitted(callback)
		expect(callback).not.toHaveBeenCalled()

		releasePersistence.resolve()
		await graphPublished.promise
		expect(callback).not.toHaveBeenCalled()

		releaseLifecycle.resolve()
		await expect(update).resolves.toMatchObject({
			catalogRevision: 1,
			runtimeStateRevision: 1,
		})
		await expect(read).resolves.toEqual({
			catalogRevision: 1,
			stateRevision: 1,
			applied: [pluginNodeIndexKey(provider)],
			core: [pluginNodeIndexKey(provider)],
			running: [pluginNodeIndexKey(provider)],
		})
		expect(callback).toHaveBeenCalledTimes(1)

		await expect(
			coordinator.readCommitted(async () => Promise.resolve('not synchronous')),
		).rejects.toThrow(/must return synchronously/)
		await coordinator.dispose()
	})
})

function definition(name: string): PluginDefinitionAddress {
	return Object.freeze({
		entry: Object.freeze({ kind: 'package-root' as const, packageName: `@barrier/${name}` }),
		exportName: `${name}Plugin`,
	})
}

function node(definitionAddress: PluginDefinitionAddress): PluginNodeAddress {
	return Object.freeze({ definition: definitionAddress, variant: 'default' })
}

function emptyAdjacency(): CorePluginDependencyAdjacency {
	return Object.freeze({
		nodes: Object.freeze([]),
		required: Object.freeze([]),
		optional: Object.freeze([]),
	})
}

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void
	const promise = new Promise<T>((settle) => {
		resolve = settle
	})
	return { promise, resolve }
}
