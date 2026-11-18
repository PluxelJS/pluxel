import { BasePlugin, Plugin, parsePluginNodeAddress } from '@pluxel/core'
import { requirePluginService } from '@pluxel/core/internal'
import { SuperJSON } from 'superjson'
import { describe, expect, it, vi } from 'vitest'
import { createHost, defineHostService, HostStatePersistenceError } from '../src/index'
import { createDocumentStorage } from './helpers/document-storage'

@Plugin({ forkable: true })
class Managed extends BasePlugin {}

@Plugin()
class Delayed extends BasePlugin {
	async init() {
		await new Promise((resolve) => setTimeout(resolve, 30))
	}
}

describe('Host public policy management', () => {
	it('preserves cancellation identity when the reason is a recoverable policy error', async () => {
		await using host = await createHost({
			plugins: [],
			policy: { document: false },
		})
		const before = await host.policy.get()
		const reason = new HostStatePersistenceError(new Error('caller stopped waiting'))
		const options = { signal: AbortSignal.abort(reason) }
		for (const action of [
			() => host.policy.validate({ startConcurrency: 3 }, options),
			() => host.policy.patch({ startConcurrency: 3 }, options),
			() => host.policy.reset(undefined, options),
		])
			await expect(action()).rejects.toBe(reason)
		expect(await host.policy.get()).toEqual(before)
	})

	it('previews raw edits, retains shadowed values, resets inheritance and detects stale tokens', async () => {
		await using host = await createHost({
			plugins: [],
			policy: { document: false, execution: { startConcurrency: 3 } },
		})
		const initial = await host.policy.get()
		if (initial.ok === false) throw new Error(initial.message)
		const preview = await host.policy.validate({ startConcurrency: 5 })
		expect(preview).toMatchObject({
			ok: true,
			managedInput: { startConcurrency: 5 },
			effective: { startConcurrency: 3 },
			sources: { startConcurrency: 'declared' },
			persistence: { status: 'unchanged' },
		})
		expect(await host.policy.get()).toMatchObject({ ok: true, managedInput: {} })
		const saved = await host.policy.patch(
			{ startConcurrency: 5 },
			{ expectedManagedRevision: initial.managedRevision },
		)
		expect(saved).toMatchObject({
			ok: true,
			shadowedFields: ['startConcurrency'],
			pendingExecutionFields: [],
			persistence: { status: 'confirmed', retention: 'session' },
			report: { writtenFields: ['startConcurrency'] },
		})
		await expect(
			host.policy.reset(undefined, { expectedManagedRevision: initial.managedRevision }),
		).resolves.toMatchObject({ ok: false, code: 'revision_conflict', state: 'unchanged' })
		await expect(host.policy.reset([])).resolves.toMatchObject({
			ok: true,
			managedInput: { startConcurrency: 5 },
			persistence: { status: 'unchanged' },
		})
		await expect(host.policy.reset()).resolves.toMatchObject({
			ok: true,
			managedInput: {},
			effective: { startConcurrency: 3 },
		})
	})

	it('binds saved execution values before service prepare and changes them only in a new Host', async () => {
		const storage = createDocumentStorage()
		await storage.put('state.json', SuperJSON.stringify({ version: 8, startTimeoutMs: 2000 }))
		let prepared = false
		const options = {
			plugins: [{ plugin: Delayed, autoStart: true }],
			policy: {
				document: { storage: () => storage },
				execution: { startTimeoutMs: 5 },
				modes: { startTimeoutMs: 'saved-first' as const },
			},
			services: [
				defineHostService({
					name: 'ExecutionProbe',
					provides: [],
					prepare({ ctx }) {
						requirePluginService(ctx)
						prepared = true
					},
				}),
			],
		}
		const host = await createHost(options)
		try {
			expect(prepared).toBe(true)
			await host.start()
			expect(requirePluginService(host.ctx).isRunning(Delayed.nodeAddress())).toBe(true)
			await expect(host.policy.patch({ startTimeoutMs: 5 })).resolves.toMatchObject({
				ok: true,
				appliedExecution: { startTimeoutMs: 2000 },
				effective: { startTimeoutMs: 5 },
				pendingExecutionFields: ['startTimeoutMs'],
				application: 'requires-host-recreation',
			})
			await host.restartNode(Delayed.nodeAddress())
			expect(requirePluginService(host.ctx).isRunning(Delayed.nodeAddress())).toBe(true)
		} finally {
			await host.close()
		}
		await using reopened = await createHost(options)
		await reopened.start()
		expect(await reopened.policy.get()).toMatchObject({
			ok: true,
			appliedExecution: { startTimeoutMs: 5 },
			pendingExecutionFields: [],
		})
		expect(requirePluginService(reopened.ctx).isRunning(Delayed.nodeAddress())).toBe(false)
	})

	it('validates mixed graph columns atomically and preserves running intent when autoStart changes', async () => {
		await using host = await createHost({ plugins: [{ plugin: Managed }] })
		const node = Managed.nodeAddress(),
			fork = Managed.nodeAddress('tenant')
		await host.startNode(node)
		await expect(
			host.policy.patch({ autoStart: [{ node: fork, autoStart: true }] }),
		).resolves.toMatchObject({
			ok: false,
			code: 'invalid_input',
		})
		expect(await host.policy.get()).toMatchObject({ ok: true, managedInput: {} })
		await expect(
			host.policy.patch({
				autoStart: [{ node, autoStart: true }],
				forks: [{ node: fork, deploy: true }],
			}),
		).resolves.toMatchObject({
			ok: true,
			report: { writtenFields: ['autoStart', 'forks'] },
		})
		await host.policy.patch({ autoStart: [{ node, autoStart: false }] })
		expect(requirePluginService(host.ctx).isRunning(node)).toBe(true)
		await host.policy.patch({ forks: [{ node: fork, deploy: false }] })
		expect(await host.policy.get()).toMatchObject({ ok: true, effective: { forks: [] } })
	})

	it('reports unconfirmed persistence without publishing the candidate', async () => {
		const storage = createDocumentStorage()
		await using host = await createHost({
			plugins: [],
			policy: { document: { storage: () => storage } },
		})
		const initial = await host.policy.get()
		storage.put = async () => {
			throw new Error('write acknowledgement lost')
		}
		await expect(host.policy.patch({ drainTimeoutMs: 5000 })).resolves.toMatchObject({
			ok: false,
			code: 'persistence_failed',
			state: 'unknown',
			persistence: { status: 'unknown' },
		})
		expect(await host.policy.get()).toEqual(initial)
	})

	it('rejects readonly edits, foreign revisions and malformed fields before any writes', async () => {
		await using first = await createHost({ plugins: [] })
		await using second = await createHost({
			plugins: [],
			policy: { document: { readOnly: true } },
		})
		const snapshot = await first.policy.get()
		if (snapshot.ok === false) throw new Error(snapshot.message)
		await expect(
			second.policy.patch(
				{ stopConcurrency: 2 },
				{ expectedManagedRevision: snapshot.managedRevision },
			),
		).resolves.toMatchObject({ ok: false, code: 'revision_conflict' })
		await expect(second.policy.patch({ stopConcurrency: 2 })).resolves.toMatchObject({
			ok: false,
			code: 'mutation_rejected',
		})
		await expect(first.policy.patch({ mode: {} } as never)).resolves.toMatchObject({
			ok: false,
			code: 'invalid_input',
		})
		await expect(first.policy.patch({ startTimeoutMs: 2_147_483_648 })).resolves.toMatchObject({
			ok: false,
			code: 'invalid_input',
		})
		const getter = vi.fn(() => 'autoStart')
		const resetKeys: string[] = []
		Object.defineProperty(resetKeys, '0', { enumerable: true, get: getter })
		await expect(first.policy.reset(resetKeys as never)).resolves.toMatchObject({
			ok: false,
			code: 'invalid_input',
		})
		expect(getter).not.toHaveBeenCalled()
		const abort = AbortSignal.abort(new Error('cancelled'))
		await expect(first.policy.get({ signal: abort })).rejects.toThrow('cancelled')
	})
})

it('persists independent choices and restores missing records in one revision', async () => {
	const storage = createDocumentStorage()
	const disabled = parsePluginNodeAddress(Managed.nodeAddress())
	const savedNode = parsePluginNodeAddress(Delayed.nodeAddress())
	await storage.put(
		'state.json',
		SuperJSON.stringify({
			version: 8,
			autoStart: [{ node: savedNode, autoStart: true }],
		}),
	)
	const options = {
		inputMode: 'saved-first',
		plugins: [
			{ plugin: Managed, autoStart: false, policyMode: 'declared-only' },
			{ plugin: Delayed },
		],
		policy: { document: { storage: () => storage } },
	} as const
	{
		await using host = await createHost(options)
		const before = await host.policy.get()
		if (before.ok === false) throw new Error(before.message)
		expect(before.effective.autoStart).toEqual([savedNode])
		await expect(host.setAutoStart(disabled, true)).rejects.toMatchObject({
			code: 'policy_shadowed',
		})
		expect(await host.policy.get()).toEqual(before)
		const changed = await host.policy.patch(
			{
				autoStart: [
					{ node: disabled, autoStart: true },
					{ node: savedNode, autoStart: false },
				],
			},
			{ expectedManagedRevision: before.managedRevision },
		)
		if (changed.ok === false) throw new Error(changed.message)
		expect(changed.effective.autoStart).toEqual([])
		expect(changed.selections).toEqual(
			expect.arrayContaining([
				{
					target: { field: 'autoStart', node: disabled },
					mode: 'declared-only',
					source: 'declared',
					shadowed: true,
				},
				{
					target: { field: 'autoStart', node: savedNode },
					mode: 'saved-first',
					source: 'saved',
					shadowed: false,
				},
			]),
		)
		await expect(
			host.policy.patch(
				{
					autoStart: [{ node: savedNode, autoStart: true }],
					reset: [{ field: 'autoStart', node: disabled }],
				},
				{ expectedManagedRevision: changed.managedRevision },
			),
		).resolves.toMatchObject({
			ok: true,
			managedInput: before.managedInput,
			effective: before.effective,
		})
	}
	await using reopened = await createHost(options)
	expect(await reopened.policy.get()).toMatchObject({
		ok: true,
		managedInput: { autoStart: [{ node: savedNode, autoStart: true }] },
		effective: { autoStart: [savedNode] },
	})
})

@Plugin({ forkable: true, startTimeoutMs: 10 })
class TimedFork extends BasePlugin {
	async init() {
		await new Promise((resolve) => setTimeout(resolve, 60))
	}
}

it('selects a concrete generation timeout per node and per Host before resource preparation', async () => {
	const defaultNode = parsePluginNodeAddress(TimedFork.nodeAddress())
	const inherited = parsePluginNodeAddress(TimedFork.nodeAddress('inherited'))
	const overridden = parsePluginNodeAddress(TimedFork.nodeAddress('overridden'))
	const delayedNode = parsePluginNodeAddress(Delayed.nodeAddress())
	const plugins = [
		{
			plugin: TimedFork,
			autoStart: true,
			startTimeoutMs: 500,
			forks: {
				inherited: { autoStart: true },
				overridden: { autoStart: true, startTimeoutMs: 500 },
			},
		},
		{ plugin: Delayed, autoStart: true },
	] as const
	await using first = await createHost({ plugins, policy: { execution: { startTimeoutMs: 15 } } })
	await using second = await createHost({
		plugins: [
			{
				plugin: TimedFork,
				autoStart: true,
				startTimeoutMs: 20,
				forks: { overridden: { autoStart: true, startTimeoutMs: 500 } },
			},
			{ plugin: Delayed, autoStart: true },
		],
	})
	await Promise.all([first.start(), second.start()])
	const { statuses: firstStatus } = await first.status()
	const { statuses: secondStatus } = await second.status()
	expect(firstStatus).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ address: defaultNode, lifecycleState: 'running' }),
			expect.objectContaining({
				address: inherited,
				lifecycleState: 'stopped',
				issues: expect.arrayContaining([
					expect.objectContaining({ message: expect.stringContaining('10ms') }),
				]),
			}),
			expect.objectContaining({ address: overridden, lifecycleState: 'running' }),
			expect.objectContaining({
				address: delayedNode,
				lifecycleState: 'stopped',
				issues: expect.arrayContaining([
					expect.objectContaining({ message: expect.stringContaining('15ms') }),
				]),
			}),
		]),
	)
	expect(secondStatus).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				address: defaultNode,
				lifecycleState: 'stopped',
				issues: expect.arrayContaining([
					expect.objectContaining({ message: expect.stringContaining('20ms') }),
				]),
			}),
			expect.objectContaining({ address: overridden, lifecycleState: 'running' }),
			expect.objectContaining({ address: delayedNode, lifecycleState: 'running' }),
		]),
	)
	const prepare = vi.fn()
	await expect(
		createHost({
			plugins: [{ plugin: TimedFork, startTimeoutMs: 2_147_483_648 }],
			services: [defineHostService({ name: 'TimeoutProbe', provides: [], prepare })],
		}),
	).rejects.toThrow('plugins[0].startTimeoutMs')
	expect(prepare).not.toHaveBeenCalled()
})

@Plugin()
class ManagedConsumer extends BasePlugin {
	constructor(readonly provider: Managed) {
		super()
	}
}

it('persists a cleared consumer override and restores the declared provider on reset', async () => {
	const storage = createDocumentStorage()
	const consumerAddress = parsePluginNodeAddress(ManagedConsumer.nodeAddress())
	const requirementAddress = Managed.address()
	const fork = parsePluginNodeAddress(Managed.nodeAddress('east'))
	const original = parsePluginNodeAddress(Managed.nodeAddress())
	const options = {
		plugins: [
			{ plugin: Managed, forks: { east: {} } },
			{
				plugin: ManagedConsumer,
				autoStart: true,
				policyMode: 'saved-first',
				dependencyOverrides: [{ requirementAddress, providerAddress: fork }],
			},
		],
		policy: { document: { storage: () => storage } },
	} as const
	const edges = (host: Awaited<ReturnType<typeof createHost>>) =>
		requirePluginService(host.ctx).readCommittedDependencyAdjacency().required

	{
		await using host = await createHost(options)
		await host.start()
		expect(edges(host)).toContainEqual({ consumer: consumerAddress, provider: fork })
		await host.setDependencyOverride(consumerAddress, requirementAddress, null)
		expect(edges(host)).toContainEqual({ consumer: consumerAddress, provider: original })
		expect(await host.policy.get()).toMatchObject({
			ok: true,
			managedInput: {
				dependencyOverrides: [{ consumerAddress, requirementAddress, providerAddress: null }],
			},
		})
	}

	await using reopened = await createHost(options)
	await reopened.start()
	expect(edges(reopened)).toContainEqual({ consumer: consumerAddress, provider: original })
	await expect(
		reopened.policy.reset([{ field: 'dependencyOverrides', consumerAddress, requirementAddress }]),
	).resolves.toMatchObject({ ok: true, managedInput: {} })
	expect(edges(reopened)).toContainEqual({ consumer: consumerAddress, provider: fork })
})
