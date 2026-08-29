import type { PluginDefinitionAddress, PluginNodeAddress } from '@pluxel/core'
import { createMemoryPersistenceBackend } from '@pluxel/runtime'
import { createRuntimeContext, createRuntimeHost } from '@pluxel/runtime/test'
import { requireRuntimeStateStore } from '@pluxel/runtime/internal'
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
	it('rejects legacy and unknown startup snapshot fields instead of silently dropping them', () => {
		expect(() =>
			createRuntimeContext({
				persistence: { mode: 'memory' },
				runtimeState: {
					mode: 'memory',
					snapshot: { enabled: [ProviderNode] },
				} as never,
			}),
		).toThrow(/runtimeState\.snapshot has unknown field enabled/i)
	})

	it.each([
		[
			'legacy root field',
			{
				version: 5,
				autoStart: [],
				enabled: [ProviderNode],
				forks: [],
				providerDefaults: [],
				dependencyOverrides: [],
			},
			/unknown field enabled/i,
		],
		[
			'unknown nested field',
			{
				version: 5,
				autoStart: [],
				forks: [{ definition: Provider, forkIds: ['tenant'], enabled: true }],
				providerDefaults: [],
				dependencyOverrides: [],
			},
			/forks\[0\] has unknown field enabled/i,
		],
	] as const)('rejects a v5 file with %s', async (_case, file, expected) => {
		const backend = createMemoryPersistenceBackend()
		await backend.namespace('runtime-state').put('state.json', SuperJSON.stringify(file))
		const runtime = createRuntimeContext({
			persistence: { mode: 'readonly', backend },
			runtimeState: {},
		})
		try {
			await expect(requireRuntimeStateStore(runtime.ctx).ready).rejects.toThrow(expected)
		} finally {
			await runtime.dispose()
		}
	})

	it('loads existing state through a readonly backend and rejects mutation', async () => {
		const backend = createMemoryPersistenceBackend()
		const persisted = SuperJSON.stringify({
			version: 5,
			autoStart: [ProviderNode],
			forks: [],
			providerDefaults: [],
			dependencyOverrides: [],
		})
		await backend.namespace('runtime-state').put('state.json', persisted)
		const runtime = createRuntimeContext({
			persistence: { mode: 'readonly', backend },
			runtimeState: {},
		})
		try {
			const runtimeState = requireRuntimeStateStore(runtime.ctx)
			await runtimeState.ready
			expect(runtimeState.snapshot().autoStart).toEqual([ProviderNode])
			const before = runtimeState.versionedSnapshot()
			await expect(runtimeState.commitVersioned(before.revision, before.state)).rejects.toThrow(
				/readonly mode/i,
			)
			expect(await backend.namespace('runtime-state').getText('state.json')).toBe(persisted)
		} finally {
			await runtime.dispose()
		}
	})

	it('keeps the startup state snapshot when a readonly file is absent', async () => {
		const backend = createMemoryPersistenceBackend()
		const runtime = createRuntimeContext({
			persistence: { mode: 'readonly', backend },
			runtimeState: { snapshot: { autoStart: [ProviderNode] } },
		})
		try {
			const runtimeState = requireRuntimeStateStore(runtime.ctx)
			await runtimeState.ready
			expect(runtimeState.snapshot().autoStart).toEqual([ProviderNode])
			expect(await backend.namespace('runtime-state').stat('state.json')).toBeUndefined()
		} finally {
			await runtime.dispose()
		}
	})

	it.each([
		['malformed', '{'],
		[
			'unsupported version',
			SuperJSON.stringify({
				version: 4,
				autoStart: [],
				forks: [],
				providerDefaults: [],
				dependencyOverrides: [],
			}),
		],
	])('fails fast on %s readonly state without isolating or rewriting it', async (_case, text) => {
		const backend = createMemoryPersistenceBackend()
		await backend.namespace('runtime-state').put('state.json', text)
		const runtime = createRuntimeContext({
			persistence: { mode: 'readonly', backend },
			runtimeState: {},
		})
		try {
			await expect(requireRuntimeStateStore(runtime.ctx).ready).rejects.toThrow(/RuntimeStateStore/)
			expect(await backend.namespace('runtime-state').getText('state.json')).toBe(text)
			const keys: string[] = []
			for await (const entry of backend.namespace('runtime-state').list()) keys.push(entry.key)
			expect(keys).toEqual(['state.json'])
		} finally {
			await runtime.dispose()
		}
	})

	it('compare-and-commits coordinator snapshots without accepting a stale revision', async () => {
		const host = createRuntimeHost({
			workbench: false,
			runtimeState: { mode: 'memory' },
		})
		try {
			const runtimeState = requireRuntimeStateStore(host.ctx)
			await runtimeState.ready
			const before = runtimeState.versionedSnapshot()
			const committed = await runtimeState.commitVersioned(before.revision, {
				...before.state,
				autoStart: [ProviderNode],
			})
			expect(committed.revision).toBe(before.revision + 1)
			await expect(
				runtimeState.commitVersioned(before.revision, before.state),
			).rejects.toMatchObject({ code: 'runtime_state_revision_conflict' })
			expect(runtimeState.snapshot().autoStart).toEqual([ProviderNode])
		} finally {
			await host.dispose()
		}
	})

	it('reuses one immutable snapshot per revision and invalidates it on commit', async () => {
		const host = createRuntimeHost({
			workbench: false,
			runtimeState: { mode: 'memory' },
		})
		try {
			const runtimeState = requireRuntimeStateStore(host.ctx)
			await runtimeState.ready
			const before = runtimeState.versionedSnapshot()
			expect(runtimeState.versionedSnapshot()).toBe(before)
			expect(runtimeState.snapshot()).toBe(before.state)
			expect(runtimeState.snapshot()).toBe(runtimeState.snapshot())

			const committed = await runtimeState.commitVersioned(before.revision, {
				...before.state,
				autoStart: [ProviderNode],
			})
			expect(committed).not.toBe(before)
			expect(committed.state).not.toBe(before.state)
			expect(runtimeState.versionedSnapshot()).toBe(committed)
			expect(runtimeState.snapshot()).toBe(committed.state)
		} finally {
			await host.dispose()
		}
	})

	it('keeps v5 structured addresses and requirement overrides stable', async () => {
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
				version: 5,
				autoStart: [],
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
			const runtimeState = requireRuntimeStateStore(host.ctx)
			await runtimeState.ready
			expect(runtimeState.snapshot()).toEqual({
				autoStart: [],
				forks: [],
				providerDefaults: [],
				dependencyOverrides: [override],
			})
		} finally {
			await host.dispose()
		}
	})

	it.each([1, 2, 3, 4])('rejects unsupported persisted v%s state', async (version) => {
		const backend = createMemoryPersistenceBackend()
		await backend
			.namespace('runtime-state')
			.put('state.json', SuperJSON.stringify({ version, autoStart: ['NameOnlyPlugin'] }))
		const host = createRuntimeHost({
			workbench: false,
			persistence: { mode: 'custom', backend },
			runtimeState: { mode: 'file' },
		})
		try {
			await expect(requireRuntimeStateStore(host.ctx).ready).rejects.toThrow(
				new RegExp(`unsupported persisted state version: ${version}`, 'i'),
			)
		} finally {
			await host.dispose()
		}
	})

	it('rejects duplicate v5 node and requirement records', async () => {
		const backend = createMemoryPersistenceBackend()
		await backend.namespace('runtime-state').put(
			'state.json',
			SuperJSON.stringify({
				version: 5,
				autoStart: [ProviderNode, ProviderNode],
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
			await expect(requireRuntimeStateStore(host.ctx).ready).rejects.toThrow(
				/duplicates an earlier node/i,
			)
		} finally {
			await host.dispose()
		}
	})

	it('rejects invalid v5 fork ids', async () => {
		const backend = createMemoryPersistenceBackend()
		await backend.namespace('runtime-state').put(
			'state.json',
			SuperJSON.stringify({
				version: 5,
				autoStart: [],
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
			await expect(requireRuntimeStateStore(host.ctx).ready).rejects.toThrow(/fork id/i)
		} finally {
			await host.dispose()
		}
	})
})
