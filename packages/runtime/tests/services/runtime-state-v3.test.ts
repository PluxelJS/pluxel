import type { PluginDefinitionAddressSnapshot, PluginNodeAddressSnapshot } from '@pluxel/core'
import { createMemoryPersistenceBackend } from '@pluxel/runtime'
import { createRuntimeHost } from '@pluxel/runtime/test'
import { SuperJSON } from 'superjson'
import { describe, expect, it } from 'vitest'

const Provider: PluginDefinitionAddressSnapshot = {
	entry: { kind: 'package-root', packageName: '@example/provider' },
	exportName: 'ProviderPlugin',
}
const Consumer: PluginDefinitionAddressSnapshot = {
	entry: { kind: 'source-entry', source: 'src/consumer.ts' },
	exportName: 'ConsumerPlugin',
}
const ProviderNode: PluginNodeAddressSnapshot = { definition: Provider, instance: 'default' }
const ConsumerNode: PluginNodeAddressSnapshot = { definition: Consumer, instance: 'default' }

describe('RuntimeState v3 persistence', () => {
	it('round-trips structured definition and node addresses without string keys', async () => {
		const backend = createMemoryPersistenceBackend()
		const namespace = backend.namespace('runtime-state')
		await namespace.put(
			'state.json',
			SuperJSON.stringify({
				version: 3,
				enabled: [ProviderNode, ConsumerNode],
				forks: [{ definition: Provider, forkIds: ['worker'] }],
				providerDefaults: [{ token: Provider, provider: ProviderNode }],
				dependencyOverrides: [
					{ consumer: ConsumerNode, parameterIndex: 0, provider: ProviderNode },
				],
			}),
		)

		const host = createRuntimeHost({
			workbench: false,
			persistence: { mode: 'custom', backend },
			runtimeState: { mode: 'file' },
		})
		try {
			await host.ctx.runtimeState.ready
			expect(host.ctx.runtimeState.snapshot()).toEqual({
				enabled: [ProviderNode, ConsumerNode],
				forks: [{ definition: Provider, forkIds: ['worker'] }],
				providerDefaults: [{ token: Provider, provider: ProviderNode }],
				dependencyOverrides: [
					{ consumer: ConsumerNode, parameterIndex: 0, provider: ProviderNode },
				],
			})

			await host.ctx.runtimeState.flush({ force: true })
			const persisted = SuperJSON.parse((await namespace.getText('state.json'))!) as Record<
				string,
				unknown
			>
			expect(persisted.version).toBe(3)
			expect(persisted.enabled).toEqual([ProviderNode, ConsumerNode])
			expect(persisted).not.toHaveProperty('optionalKnown')
			expect(persisted).not.toHaveProperty('pluginGroups')
		} finally {
			await host.dispose()
		}
	})

	it.each([1, 2])('rejects persisted v%s instead of migrating name state', async (version) => {
		const backend = createMemoryPersistenceBackend()
		await backend
			.namespace('runtime-state')
			.put('state.json', SuperJSON.stringify({ version, enabled: ['LegacyPlugin'] }))
		const host = createRuntimeHost({
			workbench: false,
			persistence: { mode: 'custom', backend },
			runtimeState: { mode: 'file' },
		})
		try {
			await expect(host.ctx.runtimeState.ready).rejects.toThrow(
				new RegExp(`unsupported persisted state version: ${version}`, 'i'),
			)
		} finally {
			await host.dispose()
		}
	})

	it('rejects malformed addresses and duplicate node records', async () => {
		const backend = createMemoryPersistenceBackend()
		await backend.namespace('runtime-state').put(
			'state.json',
			SuperJSON.stringify({
				version: 3,
				enabled: [ProviderNode, ProviderNode],
				forks: [],
				providerDefaults: [],
				dependencyOverrides: [],
			}),
		)
		const host = createRuntimeHost({
			workbench: false,
			persistence: { mode: 'custom', backend },
			runtimeState: { mode: 'file' },
		})
		try {
			await expect(host.ctx.runtimeState.ready).rejects.toThrow(/duplicates an earlier node/i)
		} finally {
			await host.dispose()
		}
	})
})
