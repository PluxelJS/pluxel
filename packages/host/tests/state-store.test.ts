import type { PluginDefinitionAddress, PluginNodeAddress } from '@pluxel/core'
import { createCoreContextHost } from '@pluxel/core/host'
import { SuperJSON } from 'superjson'
import { describe, expect, it, vi } from 'vitest'
import { HostStateStore, snapshotHostPolicy } from '../src/state-store'
import { hostStatePatch } from '../src/state'
import { createDocumentStorage } from './helpers/document-storage'

const definition: PluginDefinitionAddress = {
	entry: { kind: 'package-subpath', packageName: '@example/provider', subpath: './plugins' },
	exportName: 'Provider',
}
const owner: PluginNodeAddress = { definition, variant: 'default' }
const other: PluginNodeAddress = {
	definition: { ...definition, exportName: 'Other' },
	variant: 'default',
}
const fork = { definition, variant: 'fork' as const, forkId: 'tenant' }

describe('Host policy persistence and selection', () => {
	it('captures declarations without initializing a missing document or managed columns', async () => {
		const storage = createDocumentStorage()
		const store = new HostStateStore(
			createCoreContextHost().createRoot(),
			{ autoStart: [owner], forks: [fork] },
			{ storage },
		)
		try {
			await store.ready
			expect(store.managedSnapshot()).toEqual({})
			expect(store.snapshot()).toMatchObject({ autoStart: [owner], forks: [fork] })
			expect(storage.documents.size).toBe(0)
			await store.commitVersioned(store.versionedSnapshot().revision, { startTimeoutMs: 12_000 })
			expect(SuperJSON.parse(storage.documents.get('state.json')!)).toEqual({
				version: 7,
				startTimeoutMs: 12_000,
			})
			expect(store.configurationSnapshot()).toMatchObject({
				appliedExecution: { startTimeoutMs: 1500 },
				pendingExecutionFields: ['startTimeoutMs'],
				application: 'requires-host-recreation',
			})
		} finally {
			await store.ctx.effects.dispose()
		}
		const reopened = new HostStateStore(createCoreContextHost().createRoot(), {}, { storage })
		try {
			await reopened.ready
			expect(reopened.executionSnapshot().startTimeoutMs).toBe(12_000)
		} finally {
			await reopened.ctx.effects.dispose()
		}
	})

	it.each([
		['declared-only', [owner], 1500],
		['declared-first', [owner], 9_000],
		['saved-first', [other], 9_000],
	] as const)(
		'selects %s independently and preserves explicit saved empty arrays',
		async (mode, expected, timeout) => {
			const storage = createDocumentStorage()
			await storage.put(
				'state.json',
				SuperJSON.stringify({ version: 7, autoStart: [other], forks: [], startTimeoutMs: 9_000 }),
			)
			const store = new HostStateStore(
				createCoreContextHost().createRoot(),
				{
					autoStart: [owner],
					forks: [fork],
					mode: { autoStart: mode, forks: 'saved-first', startTimeoutMs: mode },
				},
				{ storage },
			)
			try {
				await store.ready
				expect(store.snapshot().autoStart).toEqual(expected)
				expect(store.snapshot().forks).toEqual([])
				expect(store.executionSnapshot().startTimeoutMs).toBe(timeout)
				await storage.put('state.json', SuperJSON.stringify({ version: 7, autoStart: [] }))
				expect(store.snapshot().autoStart).toEqual(expected)
			} finally {
				await store.ctx.effects.dispose()
			}
		},
	)

	it('lets pure saves edit shadowed input while actions refuse an ineffective target', async () => {
		const store = new HostStateStore(createCoreContextHost().createRoot(), { autoStart: [owner] })
		try {
			await store.ready
			expect(
				store.prepareAction(
					hostStatePatch({ type: 'set-auto-start', node: owner, autoStart: true }),
				),
			).toEqual({})
			expect(() =>
				store.prepareAction(
					hostStatePatch({ type: 'set-auto-start', node: owner, autoStart: false }),
				),
			).toThrow(expect.objectContaining({ code: 'policy_shadowed' }))
			await store.commitVersioned(0, { autoStart: [other] })
			expect(store.configurationSnapshot()).toMatchObject({
				managedInput: { autoStart: [other] },
				effective: { autoStart: [owner] },
				shadowedFields: ['autoStart'],
			})
		} finally {
			await store.ctx.effects.dispose()
		}
	})

	it('materializes only the changed effective column and preserves its other members', async () => {
		const store = new HostStateStore(createCoreContextHost().createRoot(), {
			autoStart: [owner],
			forks: [fork],
			mode: { autoStart: 'saved-first' },
		})
		try {
			await store.ready
			const candidate = store.prepareAction(
				hostStatePatch({ type: 'set-auto-start', node: other, autoStart: true }),
			)
			expect(candidate).toEqual({
				autoStart: [other, owner].sort((a, b) =>
					a.definition.exportName.localeCompare(b.definition.exportName),
				),
			})
			await store.commitVersioned(0, candidate)
			expect(store.managedSnapshot().forks).toBeUndefined()
		} finally {
			await store.ctx.effects.dispose()
		}
	})

	it('keeps readonly declarations without creating files and rejects writes before persistence', async () => {
		const storage = createDocumentStorage()
		const put = vi.spyOn(storage, 'put')
		const store = new HostStateStore(
			createCoreContextHost().createRoot(),
			{ autoStart: [owner] },
			{ storage, readOnly: true },
		)
		try {
			await store.ready
			expect(store.snapshot().autoStart).toEqual([owner])
			await expect(store.commitVersioned(0, {})).rejects.toMatchObject({
				code: 'mutation_rejected',
			})
			expect(put).not.toHaveBeenCalled()
		} finally {
			await store.ctx.effects.dispose()
		}
	})

	it.each([
		{ version: 6 },
		{ version: 7, unknown: true },
		{ version: 7, autoStart: [owner, owner] },
		{ version: 7, forks: [owner] },
		{ version: 7, forks: [{ ...fork, forkId: 'bad/id' }] },
		{ version: 7, startTimeoutMs: 2_147_483_648 },
		{ version: 7, stopConcurrency: 0 },
	])('rejects invalid persisted input without altering it: %j', async (input) => {
		const storage = createDocumentStorage()
		const text = SuperJSON.stringify(input)
		await storage.put('state.json', text)
		const store = new HostStateStore(
			createCoreContextHost().createRoot(),
			{ mode: { startTimeoutMs: 'declared-only' } },
			{ storage },
		)
		try {
			await expect(store.ready).rejects.toThrow('Cannot load state.json')
			expect(storage.documents.get('state.json')).toBe(text)
			expect(store.isReady).toBe(false)
		} finally {
			await store.ctx.effects.dispose()
		}
	})

	it('rejects mixed-mode graph references that omit their fork', async () => {
		const storage = createDocumentStorage()
		await storage.put(
			'state.json',
			SuperJSON.stringify({ version: 7, autoStart: [fork], forks: [fork] }),
		)
		const store = new HostStateStore(
			createCoreContextHost().createRoot(),
			{ mode: { forks: 'declared-only' } },
			{ storage },
		)
		try {
			await expect(store.ready).rejects.toThrow('absent from policy.forks')
		} finally {
			await store.ctx.effects.dispose()
		}
	})

	it('does not publish an uncertain write and advances tokens only after confirmed changes', async () => {
		const storage = createDocumentStorage()
		const store = new HostStateStore(createCoreContextHost().createRoot(), {}, { storage })
		try {
			await store.ready
			const before = store.versionedSnapshot()
			const token = store.managedRevision()
			storage.put = async () => {
				throw new Error('unconfirmed')
			}
			await expect(store.commitVersioned(before.revision, { autoStart: [owner] })).rejects.toThrow(
				'unconfirmed',
			)
			expect(store.versionedSnapshot()).toBe(before)
			expect(store.managedRevision()).toBe(token)
			storage.put = async () => {}
			await store.commitVersioned(before.revision, { autoStart: [owner] })
			expect(store.managedRevision()).not.toBe(token)
			expect(() => store.assertManagedRevision(token)).toThrow(
				expect.objectContaining({ code: 'revision_conflict' }),
			)
			await expect(store.commitVersioned(before.revision, {})).rejects.toMatchObject({
				code: 'runtime_state_revision_conflict',
			})
		} finally {
			await store.ctx.effects.dispose()
		}
	})

	it.each([
		{ mode: 'saved-first' },
		{ mode: { typo: 'saved-first' } },
		{ startConcurrency: 0 },
		{ startTimeoutMs: Infinity },
		{ autoStart: [owner, owner] },
		{ stopConcurrency: undefined, extra: true },
	])('rejects malformed author policy before resources: %j', (input) => {
		expect(() => snapshotHostPolicy(input as never)).toThrow(/policy|duplicates/)
	})
})

it('captures author autoStart without executing array accessors or dropping sparse entries', () => {
	const getter = vi.fn(() => owner)
	const values: PluginNodeAddress[] = []
	Object.defineProperty(values, '0', { enumerable: true, get: getter })
	expect(() => snapshotHostPolicy({ autoStart: values })).toThrow(/data properties/)
	expect(getter).not.toHaveBeenCalled()
	expect(() => snapshotHostPolicy({ autoStart: Array<PluginNodeAddress>(1) })).toThrow(
		/dense array/,
	)
})
