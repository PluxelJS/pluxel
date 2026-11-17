import { BasePlugin, Plugin } from '@pluxel/core'
import { requirePluginService } from '@pluxel/core/internal'
import { SuperJSON } from 'superjson'
import { describe, expect, it, vi } from 'vitest'
import { createHost, defineHostService } from '../src/index'
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
	it('previews raw edits, retains shadowed values, resets inheritance and detects stale tokens', async () => {
		await using host = await createHost({
			plugins: [],
			policy: { startConcurrency: 3 },
			runtime: { documents: { state: false } },
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
		await storage.put('state.json', SuperJSON.stringify({ version: 7, startTimeoutMs: 2000 }))
		let prepared = false
		const options = {
			plugins: [Delayed],
			policy: {
				autoStart: [Delayed],
				startTimeoutMs: 5,
				mode: { startTimeoutMs: 'saved-first' as const },
			},
			runtime: { documents: { state: { storage: () => storage } } },
			services: [
				defineHostService({
					name: 'ExecutionProbe',
					capabilities: [],
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
		await using host = await createHost({ plugins: [Managed] })
		const node = Managed.nodeAddress(),
			fork = Managed.nodeAddress('tenant')
		await host.startNode(node)
		await expect(host.policy.patch({ autoStart: [fork] })).resolves.toMatchObject({
			ok: false,
			code: 'invalid_input',
		})
		expect(await host.policy.get()).toMatchObject({ ok: true, managedInput: {} })
		await expect(host.policy.patch({ autoStart: [node], forks: [fork] })).resolves.toMatchObject({
			ok: true,
			report: { writtenFields: ['autoStart', 'forks'] },
		})
		await host.policy.patch({ autoStart: [] })
		expect(requirePluginService(host.ctx).isRunning(node)).toBe(true)
		await host.policy.patch({ forks: [] })
		expect(await host.policy.get()).toMatchObject({ ok: true, effective: { forks: [] } })
	})

	it('reports unconfirmed persistence without publishing the candidate', async () => {
		const storage = createDocumentStorage()
		await using host = await createHost({
			plugins: [],
			runtime: { documents: { state: { storage: () => storage } } },
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
			runtime: { documents: { state: { readOnly: true } } },
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
