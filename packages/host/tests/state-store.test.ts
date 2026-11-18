import {
	BasePlugin,
	Plugin,
	parsePluginNodeAddress,
	type PluginDefinitionAddress,
	type PluginNodeAddress,
} from '@pluxel/core'
import { createCoreContextHost } from '@pluxel/core/host'
import { SuperJSON } from 'superjson'
import { describe, expect, it, vi } from 'vitest'
import { HostStateStore } from '../src/state-store'
import { canonicalHostPolicyInput, snapshotHostPolicy } from '../src/policy-input'
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

@Plugin({ forkable: true })
class PolicyAddressOwner extends BasePlugin {}

describe('Host policy persistence and selection', () => {
	it('captures declarations without initializing a missing document or managed columns', async () => {
		const storage = createDocumentStorage()
		const store = new HostStateStore(
			createCoreContextHost().createRoot(),
			snapshotHostPolicy({}, undefined, {
				autoStart: [on(owner)],
				forks: [{ node: fork, deploy: true }],
			}),
			{ storage },
		)
		try {
			await store.ready
			expect(store.managedSnapshot()).toEqual({})
			expect(store.snapshot()).toMatchObject({ autoStart: [owner], forks: [fork] })
			expect(storage.documents.size).toBe(0)
			await store.commitVersioned(store.versionedSnapshot().revision, { startTimeoutMs: 12_000 })
			expect(SuperJSON.parse(storage.documents.get('state.json')!)).toEqual({
				version: 8,
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
		const reopened = new HostStateStore(createCoreContextHost().createRoot(), undefined, {
			storage,
		})
		try {
			await reopened.ready
			expect(reopened.executionSnapshot().startTimeoutMs).toBe(12_000)
		} finally {
			await reopened.ctx.effects.dispose()
		}
	})

	it.each([
		['declared-only', [owner], 1500],
		['declared-first', [other, owner], 9_000],
		['saved-first', [other, owner], 9_000],
	] as const)(
		'selects %s for each target and honors saved fork choices',
		async (mode, expected, timeout) => {
			const storage = createDocumentStorage()
			await storage.put(
				'state.json',
				SuperJSON.stringify({
					version: 8,
					autoStart: [on(other)],
					forks: [{ node: fork, deploy: false }],
					startTimeoutMs: 9_000,
				}),
			)
			const store = new HostStateStore(
				createCoreContextHost().createRoot(),
				snapshotHostPolicy(
					{
						modes: { autoStart: mode, forks: 'saved-first', startTimeoutMs: mode },
					},
					undefined,
					{ autoStart: [on(owner)], forks: [{ node: fork, deploy: true }] },
				),
				{ storage },
			)
			try {
				await store.ready
				expect(store.snapshot().autoStart).toEqual(expected)
				expect(store.snapshot().forks).toEqual([])
				expect(store.executionSnapshot().startTimeoutMs).toBe(timeout)
				await storage.put('state.json', SuperJSON.stringify({ version: 8, autoStart: [] }))
				expect(store.snapshot().autoStart).toEqual(expected)
			} finally {
				await store.ctx.effects.dispose()
			}
		},
	)

	it('lets pure saves edit shadowed input while actions refuse an ineffective target', async () => {
		const store = new HostStateStore(
			createCoreContextHost().createRoot(),
			snapshotHostPolicy({}, undefined, { autoStart: [on(owner)] }),
		)
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
			await store.commitVersioned(0, { autoStart: [{ node: owner, autoStart: false }, on(other)] })
			expect(store.configurationSnapshot()).toMatchObject({
				managedInput: { autoStart: [on(other), { node: owner, autoStart: false }] },
				effective: { autoStart: [other, owner] },
				selections: expect.arrayContaining([
					{
						target: { field: 'autoStart', node: owner },
						source: 'declared',
						mode: 'declared-first',
						shadowed: true,
					},
					{
						target: { field: 'autoStart', node: other },
						source: 'saved',
						mode: 'declared-first',
						shadowed: false,
					},
				]),
			})
		} finally {
			await store.ctx.effects.dispose()
		}
	})

	it('persists only the touched node and preserves other declared choices', async () => {
		const store = new HostStateStore(
			createCoreContextHost().createRoot(),
			snapshotHostPolicy({ modes: { autoStart: 'saved-first' } }, undefined, {
				autoStart: [on(owner)],
				forks: [{ node: fork, deploy: true }],
			}),
		)
		try {
			await store.ready
			const candidate = store.prepareAction(
				hostStatePatch({ type: 'set-auto-start', node: other, autoStart: true }),
			)
			expect(candidate).toEqual({
				autoStart: [on(other)],
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
			snapshotHostPolicy({}, undefined, { autoStart: [on(owner)] }),
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
		{ version: 7 },
		{ version: 8, unknown: true },
		{ version: 8, autoStart: [on(owner), on(owner)] },
		{ version: 8, forks: [{ node: owner, deploy: true }] },
		{ version: 8, forks: [{ node: { ...fork, forkId: 'bad/id' }, deploy: true }] },
		{ version: 8, startTimeoutMs: 2_147_483_648 },
		{ version: 8, stopConcurrency: 0 },
	])('rejects invalid persisted input without altering it: %j', async (input) => {
		const storage = createDocumentStorage()
		const text = SuperJSON.stringify(input)
		await storage.put('state.json', text)
		const store = new HostStateStore(
			createCoreContextHost().createRoot(),
			snapshotHostPolicy({ modes: { startTimeoutMs: 'declared-only' } }),
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
			SuperJSON.stringify({
				version: 8,
				autoStart: [on(fork)],
				forks: [{ node: fork, deploy: true }],
			}),
		)
		const store = new HostStateStore(
			createCoreContextHost().createRoot(),
			snapshotHostPolicy({ modes: { forks: 'declared-only' } }),
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
		const store = new HostStateStore(createCoreContextHost().createRoot(), undefined, { storage })
		try {
			await store.ready
			const before = store.versionedSnapshot()
			const token = store.managedRevision()
			storage.put = async () => {
				throw new Error('unconfirmed')
			}
			await expect(
				store.commitVersioned(before.revision, { autoStart: [on(owner)] }),
			).rejects.toThrow('unconfirmed')
			expect(store.versionedSnapshot()).toBe(before)
			expect(store.managedRevision()).toBe(token)
			storage.put = async () => {}
			await store.commitVersioned(before.revision, { autoStart: [on(owner)] })
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
		{ mode: 'parser-default' },
		{ modes: { typo: 'saved-first' } },
		{ execution: { startConcurrency: 0 } },
		{ execution: { startTimeoutMs: Infinity } },
		{ autoStart: [owner, owner] },
		{ stopConcurrency: undefined, extra: true },
	])('rejects malformed author policy before resources: %j', (input) => {
		expect(() => snapshotHostPolicy(input as never)).toThrow(/policy|duplicates/)
	})
})

it('captures author autoStart without executing array accessors or dropping sparse entries', () => {
	const getter = vi.fn(() => owner)
	const values: ReturnType<typeof on>[] = []
	Object.defineProperty(values, '0', { enumerable: true, get: getter })
	expect(() => canonicalHostPolicyInput({ autoStart: values })).toThrow(/accessors/)
	expect(getter).not.toHaveBeenCalled()
	expect(() => canonicalHostPolicyInput({ autoStart: Array<ReturnType<typeof on>>(1) })).toThrow(
		/dense/,
	)
})

it('normalizes framework address evidence in policy and refuses detached copies', () => {
	const node = PolicyAddressOwner.nodeAddress()
	const eastFork = PolicyAddressOwner.nodeAddress('east')
	const policy = canonicalHostPolicyInput({
		autoStart: [on(node), on(eastFork)],
		forks: [{ node: eastFork, deploy: true }],
	})
	expect(policy.autoStart).toHaveLength(2)
	expect(policy.autoStart?.map((choice) => choice.node)).toEqual(
		expect.arrayContaining([node, eastFork].map(parsePluginNodeAddress)),
	)
	expect(policy.forks).toEqual([{ node: parsePluginNodeAddress(eastFork), deploy: true }])
	expect(Object.getOwnPropertySymbols(policy.autoStart![0]!)).toHaveLength(0)
	expect(() => canonicalHostPolicyInput({ autoStart: [on({ ...node })] })).toThrow(
		'copied or detached',
	)
	expect(() => canonicalHostPolicyInput({ autoStart: [on(PolicyAddressOwner as never)] })).toThrow(
		'portable data tree',
	)
})

function on(node: PluginNodeAddress) {
	return { node, autoStart: true }
}
