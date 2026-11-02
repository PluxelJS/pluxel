import type { PluginDefinitionAddress, PluginNodeAddress } from '@pluxel/core'
import { createDocumentStorage } from './helpers/document-storage'
import { createCoreContextHost } from '@pluxel/core/host'
import type { HostStateSnapshot } from '../src/policy'
import { HostStateStore, resolveHostStateDeclaration, type HostStateFile } from '../src/state-store'
import { hostStatePatch } from '../src/state'
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
	it('preserves omitted declaration fields and rejects default nodes in forks', () => {
		expect(resolveHostStateDeclaration({ autoStart: [] })).toEqual({ autoStart: [] })
		expect(() => resolveHostStateDeclaration({ forks: [ProviderNode] })).toThrow(
			/only fork node addresses/,
		)
		expect(() =>
			resolveHostStateDeclaration({ autoStart: [{ ...ProviderNode, enabled: true }] } as never),
		).toThrow(/unknown field enabled/)
	})

	it('initializes all declared lists without adding inferred policy', async () => {
		const backend = createDocumentStorage()
		const fork: PluginNodeAddress = { definition: Provider, variant: 'fork', forkId: 'tenant' }
		const declared = {
			autoStart: [ConsumerNode],
			forks: [fork],
			providerDefaults: [{ token: Consumer, provider: ProviderNode }],
			dependencyOverrides: [
				{ consumerAddress: ConsumerNode, requirementAddress: Provider, providerAddress: fork },
			],
		}
		const runtime = new HostStateStore(createCoreContextHost().createRoot(), {
			storage: backend,
			override: true,
			...declared,
		})
		try {
			await runtime.ready
			expect(runtime.savedSnapshot()).toEqual(declared)
			expect(runtime.snapshot()).toEqual(declared)
			expect(SuperJSON.parse((await backend.getText('state.json'))!)).toEqual({
				version: 6,
				...declared,
			})
		} finally {
			await runtime.ctx.effects.dispose()
		}
	})

	it('restores saved lists when override is false and never observes external edits', async () => {
		const backend = createDocumentStorage()
		const persisted: HostStateFile = {
			version: 6,
			autoStart: [ProviderNode],
			forks: [],
			providerDefaults: [],
			dependencyOverrides: [],
		}
		await backend.put('state.json', SuperJSON.stringify(persisted))
		const runtime = new HostStateStore(createCoreContextHost().createRoot(), {
			storage: backend,
			autoStart: [ConsumerNode],
		})
		try {
			await runtime.ready
			expect(runtime.snapshot().autoStart).toEqual([ProviderNode])
			expect(runtime.configurationSnapshot()).toMatchObject({
				override: false,
				declared: { autoStart: [ConsumerNode] },
				overriddenFields: [],
			})
			await backend.put('state.json', SuperJSON.stringify({ ...persisted, autoStart: [] }))
			expect(runtime.snapshot().autoStart).toEqual([ProviderNode])
		} finally {
			await runtime.ctx.effects.dispose()
		}
	})

	it('overrides whole declared lists without contaminating saved values through other writes or reopen', async () => {
		const backend = createDocumentStorage()
		const fork: PluginNodeAddress = { definition: Provider, variant: 'fork', forkId: 'tenant' }
		const saved: HostStateSnapshot = {
			autoStart: [ProviderNode],
			forks: [fork],
			providerDefaults: [],
			dependencyOverrides: [],
		}
		await backend.put('state.json', SuperJSON.stringify({ version: 6, ...saved }))
		const runtime = new HostStateStore(createCoreContextHost().createRoot(), {
			storage: backend,
			override: true,
			autoStart: [ConsumerNode],
			forks: [],
		})
		const defaults = [{ token: Consumer, provider: ProviderNode }]
		try {
			await runtime.ready
			expect(runtime.snapshot()).toEqual({ ...saved, autoStart: [ConsumerNode], forks: [] })
			expect(runtime.savedSnapshot()).toEqual(saved)
			expect(runtime.configurationSnapshot().overriddenFields).toEqual(['autoStart', 'forks'])
			expect(() =>
				runtime.assertPatchMutable(
					hostStatePatch({ type: 'set-auto-start', node: ConsumerNode, autoStart: true }),
				),
			).toThrow(expect.objectContaining({ code: 'state_overridden' }))
			await expect(
				runtime.commitVersioned(runtime.versionedSnapshot().revision, runtime.snapshot()),
			).rejects.toMatchObject({ code: 'state_overridden' })
			await runtime.commitVersioned(runtime.versionedSnapshot().revision, {
				...runtime.savedSnapshot(),
				providerDefaults: defaults,
			})
			expect(runtime.snapshot()).toEqual({
				...saved,
				autoStart: [ConsumerNode],
				forks: [],
				providerDefaults: defaults,
			})
			expect(SuperJSON.parse((await backend.getText('state.json'))!)).toEqual({
				version: 6,
				...saved,
				providerDefaults: defaults,
			})
		} finally {
			await runtime.ctx.effects.dispose()
		}
		const reopened = new HostStateStore(createCoreContextHost().createRoot(), { storage: backend })
		try {
			await reopened.ready
			expect(reopened.snapshot()).toEqual({ ...saved, providerDefaults: defaults })
		} finally {
			await reopened.ctx.effects.dispose()
		}
	})

	it('projects readonly overrides without writing and applies memory declarations without storage', async () => {
		const backend = createDocumentStorage()
		const content = SuperJSON.stringify({
			version: 6,
			autoStart: [ProviderNode],
			forks: [],
			providerDefaults: [],
			dependencyOverrides: [],
		})
		await backend.put('state.json', content)
		const runtime = new HostStateStore(createCoreContextHost().createRoot(), {
			storage: backend,
			mode: 'readonly',
			override: true,
			autoStart: [],
		})
		const memory = new HostStateStore(createCoreContextHost().createRoot(), {
			mode: 'memory',
			autoStart: [ConsumerNode],
		})
		try {
			await runtime.ready
			expect(runtime.snapshot().autoStart).toEqual([])
			expect(runtime.savedSnapshot().autoStart).toEqual([ProviderNode])
			expect(memory.snapshot().autoStart).toEqual([ConsumerNode])
			expect(memory.configurationSnapshot().mode).toBe('memory')
			expect(await backend.getText('state.json')).toBe(content)
		} finally {
			await runtime.ctx.effects.dispose()
			await memory.ctx.effects.dispose()
		}
	})

	it('persists and reloads a plugin from a package subpath', async () => {
		const backend = createDocumentStorage()
		const node: PluginNodeAddress = {
			definition: {
				entry: { kind: 'package-subpath', packageName: '@pluxel/services', subpath: './plugins' },
				exportName: 'VaultAdminPlugin',
			},
			variant: 'default',
		}
		const host = new HostStateStore(createCoreContextHost().createRoot(), { storage: backend })
		try {
			await host.ready
			const before = host.versionedSnapshot()
			await host.commitVersioned(before.revision, { ...before.state, autoStart: [node] })
			expect(host.snapshot().autoStart).toEqual([node])
		} finally {
			await host.ctx.effects.dispose()
		}
		const restored = new HostStateStore(createCoreContextHost().createRoot(), {
			storage: backend,
			mode: 'readonly',
		})
		try {
			await restored.ready
			expect(restored.snapshot().autoStart).toEqual([node])
		} finally {
			await restored.ctx.effects.dispose()
		}
	})

	it('rejects legacy and unknown startup snapshot fields instead of silently dropping them', () => {
		expect(
			() =>
				new HostStateStore(createCoreContextHost().createRoot(), {
					initial: { enabled: [ProviderNode] },
				} as never),
		).toThrow(/state has unknown field initial/i)
	})

	it.each([
		[
			'legacy root field',
			{
				version: 6,
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
				version: 6,
				autoStart: [],
				forks: [{ definition: Provider, variant: 'fork', forkId: 'tenant', enabled: true }],
				providerDefaults: [],
				dependencyOverrides: [],
			},
			/unknown field enabled/i,
		],
	] as const)('rejects a v6 file with %s', async (_case, file, expected) => {
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
			version: 6,
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
			autoStart: [ProviderNode],
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

	it.each([
		['malformed JSON', '{', /state\.json:/i],
		[
			'wrong root type',
			SuperJSON.stringify([]),
			/state\.json: .*persisted state must be an object/i,
		],
		[
			'unknown version',
			SuperJSON.stringify({ version: 4 }),
			/state\.json: .*unsupported persisted state version: 4/i,
		],
		[
			'invalid field',
			SuperJSON.stringify({
				version: 6,
				autoStart: {},
				forks: [],
				providerDefaults: [],
				dependencyOverrides: [],
			}),
			/state\.json: .*autoStart must be an array/i,
		],
	] as const)(
		'rejects %s in writable mode without writing any document',
		async (_case, text, expected) => {
			const backend = createDocumentStorage()
			await backend.put('state.json', text)
			const runtime = new HostStateStore(createCoreContextHost().createRoot(), { storage: backend })
			try {
				await expect(runtime.ready).rejects.toThrow(expected)
				await expect(runtime.ready).rejects.toThrow(
					/Existing document unchanged; repair or restore it before restarting/,
				)
				expect(runtime.isReady).toBe(false)
				const current = runtime.versionedSnapshot()
				await expect(runtime.commitVersioned(current.revision, current.state)).rejects.toThrow(
					/requires a successfully loaded state document/,
				)
			} finally {
				await runtime.ctx.effects.dispose()
			}
			expect(await backend.getText('state.json')).toBe(text)
			expect([...backend.documents.keys()]).toEqual(['state.json'])
		},
	)

	it('initializes an absent writable state document once', async () => {
		const backend = createDocumentStorage()
		const runtime = new HostStateStore(createCoreContextHost().createRoot(), { storage: backend })
		try {
			await runtime.ready
			expect(SuperJSON.parse((await backend.getText('state.json'))!)).toEqual({
				version: 6,
				autoStart: [],
				forks: [],
				providerDefaults: [],
				dependencyOverrides: [],
			})
			expect([...backend.documents.keys()]).toEqual(['state.json'])
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

	it('keeps v6 structured addresses and requirement overrides stable', async () => {
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
				version: 6,
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

	it.each([1, 2, 3, 4, 5])('rejects unsupported persisted v%s state', async (version) => {
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

	it('rejects duplicate v6 node and requirement records', async () => {
		const backend = createDocumentStorage()
		await backend.put(
			'state.json',
			SuperJSON.stringify({
				version: 6,
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

	it('rejects invalid v6 fork ids', async () => {
		const backend = createDocumentStorage()
		await backend.put(
			'state.json',
			SuperJSON.stringify({
				version: 6,
				autoStart: [],
				forks: [{ definition: Provider, variant: 'fork', forkId: 'tenant/acme' }],
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
