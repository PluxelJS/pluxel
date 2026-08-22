import type { PluginDefinitionAddress, PluginNodeAddress } from '@pluxel/core'
import { createMemoryPersistenceBackend } from '@pluxel/runtime'
import { createRuntimeHost } from '@pluxel/runtime/test'
import { SuperJSON } from 'superjson'
import { describe, expect, it } from 'vitest'

const Provider: PluginDefinitionAddress = {
	entry: { kind: 'package-root', packageName: '@example/provider' },
	exportName: 'ProviderPlugin',
}
const Consumer: PluginDefinitionAddress = {
	entry: { kind: 'source-entry', sourceSpace: 'app', path: 'src/consumer.ts' },
	exportName: 'ConsumerPlugin',
}
const ProviderNode: PluginNodeAddress = { definition: Provider, variant: 'default' }
const ConsumerNode: PluginNodeAddress = { definition: Consumer, variant: 'default' }

describe('RuntimeState address persistence', () => {
	it('keeps v4 structured addresses and requirement overrides stable', async () => {
		const backend = createMemoryPersistenceBackend()
		const namespace = backend.namespace('runtime-state')
		const override = {
			consumerAddress: ConsumerNode,
			requirementAddress: Provider,
			providerAddress: ProviderNode,
		}
		await namespace.put(
			'state.json',
			SuperJSON.stringify({
				version: 4,
				enabled: [],
				forks: [],
				providerDefaults: [],
				dependencyOverrides: [override],
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
				enabled: [],
				forks: [],
				providerDefaults: [],
				dependencyOverrides: [override],
			})
		} finally {
			await host.dispose()
		}
	})

	it.each([1, 2, 3])('rejects unsupported persisted v%s state', async (version) => {
		const backend = createMemoryPersistenceBackend()
		await backend
			.namespace('runtime-state')
			.put('state.json', SuperJSON.stringify({ version, enabled: ['NameOnlyPlugin'] }))
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

	it('rejects duplicate v4 node and requirement records', async () => {
		const backend = createMemoryPersistenceBackend()
		await backend.namespace('runtime-state').put(
			'state.json',
			SuperJSON.stringify({
				version: 4,
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

	it('rejects invalid v4 fork ids', async () => {
		const backend = createMemoryPersistenceBackend()
		await backend.namespace('runtime-state').put(
			'state.json',
			SuperJSON.stringify({
				version: 4,
				enabled: [],
				forks: [{ definition: Provider, forkIds: ['tenant/acme'] }],
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
			await expect(host.ctx.runtimeState.ready).rejects.toThrow(/fork id/i)
		} finally {
			await host.dispose()
		}
	})
})
