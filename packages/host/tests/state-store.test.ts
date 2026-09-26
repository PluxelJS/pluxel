import type { PluginDefinitionAddress, PluginNodeAddress } from '@pluxel/core'
import { createDocumentStorage } from './helpers/document-storage'
import { createCoreContextHost } from '@pluxel/core/host'
import { HostStateStore } from '../src/state-store'
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

describe('Host state address persistence', () => {
	it('rejects legacy and unknown startup snapshot fields instead of silently dropping them', () => {
		expect(
			() =>
				new HostStateStore(createCoreContextHost().createRoot(), {
					initial: { enabled: [ProviderNode] },
				} as never),
		).toThrow(/state\.initial has unknown field enabled/i)
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
		const backend = createDocumentStorage()
		await backend.put('state.json', SuperJSON.stringify(file))
		const runtime = new HostStateStore(createCoreContextHost().createRoot(), {
			storage: backend,
			mode: 'readonly',
		})
		try {
			await expect(runtime.ready).rejects.toThrow(expected)
		} finally {
			await runtime.ctx.effects.dispose()
		}
	})

	it('loads existing state through a readonly backend and rejects mutation', async () => {
		const backend = createDocumentStorage()
		const persisted = SuperJSON.stringify({
			version: 5,
			autoStart: [ProviderNode],
			forks: [],
			providerDefaults: [],
			dependencyOverrides: [],
		})
		await backend.put('state.json', persisted)
		const runtime = new HostStateStore(createCoreContextHost().createRoot(), {
			storage: backend,
			mode: 'readonly',
		})
		try {
			const runtimeState = runtime
			await runtimeState.ready
			expect(runtimeState.snapshot().autoStart).toEqual([ProviderNode])
			const before = runtimeState.versionedSnapshot()
			await expect(runtimeState.commitVersioned(before.revision, before.state)).rejects.toThrow(
				/readonly mode/i,
			)
			expect(await backend.getText('state.json')).toBe(persisted)
		} finally {
			await runtime.ctx.effects.dispose()
		}
	})

	it('keeps the startup state snapshot when a readonly file is absent', async () => {
		const backend = createDocumentStorage()
		const runtime = new HostStateStore(createCoreContextHost().createRoot(), {
			storage: backend,
			mode: 'readonly',
			initial: { autoStart: [ProviderNode] },
		})
		try {
			const runtimeState = runtime
			await runtimeState.ready
			expect(runtimeState.snapshot().autoStart).toEqual([ProviderNode])
			expect(await backend.stat('state.json')).toBeUndefined()
		} finally {
			await runtime.ctx.effects.dispose()
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
		const backend = createDocumentStorage()
		await backend.put('state.json', text)
		const runtime = new HostStateStore(createCoreContextHost().createRoot(), {
			storage: backend,
			mode: 'readonly',
		})
		try {
			await expect(runtime.ready).rejects.toThrow(/HostStateStore/)
			expect(await backend.getText('state.json')).toBe(text)
			const keys = [...backend.documents.keys()]
			expect(keys).toEqual(['state.json'])
		} finally {
			await runtime.ctx.effects.dispose()
		}
	})

	it('compare-and-commits coordinator snapshots without accepting a stale revision', async () => {
		const host = new HostStateStore(createCoreContextHost().createRoot())
		try {
			const runtimeState = host
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
			await host.ctx.effects.dispose()
		}
	})

	it('reuses one immutable snapshot per revision and invalidates it on commit', async () => {
		const host = new HostStateStore(createCoreContextHost().createRoot())
		try {
			const runtimeState = host
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
			await host.ctx.effects.dispose()
		}
	})

	it('keeps v5 structured addresses and requirement overrides stable', async () => {
		const backend = createDocumentStorage()
		const namespace = backend
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

		const host = new HostStateStore(createCoreContextHost().createRoot(), { storage: backend })
		try {
			const runtimeState = host
			await runtimeState.ready
			expect(runtimeState.snapshot()).toEqual({
				autoStart: [],
				forks: [],
				providerDefaults: [],
				dependencyOverrides: [override],
			})
		} finally {
			await host.ctx.effects.dispose()
		}
	})

	it.each([1, 2, 3, 4])('rejects unsupported persisted v%s state', async (version) => {
		const backend = createDocumentStorage()
		await backend.put('state.json', SuperJSON.stringify({ version, autoStart: ['NameOnlyPlugin'] }))
		const host = new HostStateStore(createCoreContextHost().createRoot(), { storage: backend })
		try {
			await expect(host.ready).rejects.toThrow(
				new RegExp(`unsupported persisted state version: ${version}`, 'i'),
			)
		} finally {
			await host.ctx.effects.dispose()
		}
	})

	it('rejects duplicate v5 node and requirement records', async () => {
		const backend = createDocumentStorage()
		await backend.put(
			'state.json',
			SuperJSON.stringify({
				version: 5,
				autoStart: [ProviderNode, ProviderNode],
				forks: [],
				providerDefaults: [],
				dependencyOverrides: [],
			}),
		)
		const host = new HostStateStore(createCoreContextHost().createRoot(), { storage: backend })
		try {
			await expect(host.ready).rejects.toThrow(/duplicates an earlier node/i)
		} finally {
			await host.ctx.effects.dispose()
		}
	})

	it('rejects invalid v5 fork ids', async () => {
		const backend = createDocumentStorage()
		await backend.put(
			'state.json',
			SuperJSON.stringify({
				version: 5,
				autoStart: [],
				forks: [{ definition: Provider, forkIds: ['tenant/acme'] }],
				providerDefaults: [],
				dependencyOverrides: [],
			}),
		)
		const host = new HostStateStore(createCoreContextHost().createRoot(), { storage: backend })
		try {
			await expect(host.ready).rejects.toThrow(/fork id/i)
		} finally {
			await host.ctx.effects.dispose()
		}
	})
})
