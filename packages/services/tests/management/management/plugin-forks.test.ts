import { requireHostStateStore, isPluginAutoStartEnabled, listForkIds } from '@pluxel/host/internal'
import { standardServices } from '@pluxel/services'
import {
	pluginDefinitionAddressOf,
	pluginNodeAddressOf,
	pluginNodeAddressEqual,
} from '@pluxel/core'
import { requireConfigService } from '@pluxel/core/internal'
import {
	createServiceInternalTestHarness,
	type ServiceInternalTestHarness,
} from '@pluxel/services/internal/test'
import { BasePlugin, Plugin } from '@pluxel/core/test'
import { afterEach, describe, expect, it } from 'vitest'
import { RuntimeManagementTargetImpl } from '../../../src/management/services/management/RuntimeManagementTarget.ts'
import {
	logging as loggingService,
	Logging,
	type PluginLogPolicyStore,
	type RuntimeLoggingInput,
} from '@pluxel/services/logging'
import {
	Persistence,
	createMemoryPersistenceBackend,
	type PersistenceBackend,
} from '@pluxel/services/persistence'
import type { PluginApplyReport } from '../../../src/management/web/protocol.ts'

@Plugin({ forkable: true })
class ForkProvider extends BasePlugin {}

@Plugin()
class ForkConsumer extends BasePlugin {
	constructor(readonly provider: ForkProvider) {
		super()
	}
}

@Plugin({ forkable: true })
class FailingForkProvider extends BasePlugin {
	override init(): void {
		throw new Error('fork startup failed')
	}
}

@Plugin({ forkable: true })
class DrainFailureForkProvider extends BasePlugin {
	override init(): void {
		this.ctx.effects.defer(() => {
			throw new Error('fork drain failed')
		})
	}
}

const hosts: ServiceInternalTestHarness[] = []

afterEach(async () => {
	for (const host of hosts.splice(0)) await host.dispose()
})

describe('Plugin fork control plane', () => {
	it('atomically creates, marks for auto-start, and selects a fork without starting it live', async () => {
		const host = await runtimeHost()
		host.add([ForkProvider, ForkConsumer])
		await host.commit()
		const rpc = new RuntimeManagementTargetImpl(host.ctx)
		const base = pluginNodeAddressOf(ForkProvider)
		const consumer = pluginNodeAddressOf(ForkConsumer)

		const result = await rpc.ensurePluginFork({
			base,
			forkId: 'atomic',
			autoStart: true,
			selectFor: {
				consumer,
				requirement: pluginDefinitionAddressOf(ForkProvider),
			},
		})

		expect(result).toMatchObject({
			ok: true,
			status: 'deferred',
			fork: { variant: 'fork', forkId: 'atomic' },
			report: { core: { status: 'unchanged' } },
		})
		if (result.ok === false) throw new Error(result.error)
		const state = requireHostStateStore(host.ctx).snapshot()
		expect(listForkIds(state, base.definition)).toContain('atomic')
		expect(isPluginAutoStartEnabled(state, result.fork)).toBe(true)
		expect(state.dependencyOverrides).toHaveLength(1)
		expect(pluginNodeAddressEqual(state.dependencyOverrides[0]!.providerAddress, result.fork)).toBe(
			true,
		)
		expectBrowserSafeReport(result.report)
	})

	it('rejects an invalid atomic selection without leaving fork intent behind', async () => {
		const host = await runtimeHost()
		host.add([ForkProvider, ForkConsumer])
		await host.commit()
		const rpc = new RuntimeManagementTargetImpl(host.ctx)
		const base = pluginNodeAddressOf(ForkProvider)

		await expect(
			rpc.ensurePluginFork({
				base,
				forkId: 'must-not-survive',
				autoStart: true,
				selectFor: {
					consumer: pluginNodeAddressOf(ForkConsumer),
					requirement: pluginDefinitionAddressOf(FailingForkProvider),
				},
			}),
		).resolves.toMatchObject({
			ok: false,
			code: 'requirement_not_found',
			state: 'unchanged',
		})
		const state = requireHostStateStore(host.ctx).snapshot()
		expect(listForkIds(state, base.definition)).not.toContain('must-not-survive')
		expect(state.dependencyOverrides).toEqual([])
	})

	it('reports applied and deferred ensure outcomes with reports', async () => {
		const host = await runtimeHost()
		host.add([ForkProvider, ForkConsumer, FailingForkProvider])
		host.cfg(ForkConsumer).setAutoStart(true)
		host.start(ForkConsumer)
		await host.commit()
		const rpc = new RuntimeManagementTargetImpl(host.ctx)
		const consumer = pluginNodeAddressOf(ForkConsumer)

		const applied = await rpc.ensurePluginFork({
			base: pluginNodeAddressOf(ForkProvider),
			forkId: 'running',
			autoStart: false,
			selectFor: {
				consumer,
				requirement: pluginDefinitionAddressOf(ForkProvider),
			},
		})
		expect(applied).toMatchObject({ ok: true, status: 'applied', report: {} })
		if (applied.ok) expectBrowserSafeReport(applied.report)

		const deferred = await rpc.ensurePluginFork({
			base: pluginNodeAddressOf(ForkProvider),
			forkId: 'dormant',
			autoStart: false,
		})
		expect(deferred).toMatchObject({ ok: true, status: 'deferred', report: {} })
		if (deferred.ok) expectBrowserSafeReport(deferred.report)

		const nextBoot = await rpc.ensurePluginFork({
			base: pluginNodeAddressOf(FailingForkProvider),
			forkId: 'failing',
			autoStart: true,
		})
		expect(nextBoot).toMatchObject({
			ok: true,
			status: 'deferred',
			report: { core: { status: 'unchanged' } },
		})
		if (nextBoot.ok) expectBrowserSafeReport(nextBoot.report)
	})

	it('blocks inbound references, removes after clearing them, and is idempotent', async () => {
		const host = await runtimeHost()
		host.add([ForkProvider, ForkConsumer])
		await host.commit()
		const rpc = new RuntimeManagementTargetImpl(host.ctx)
		const base = pluginNodeAddressOf(ForkProvider)
		const consumer = pluginNodeAddressOf(ForkConsumer)
		const ensured = await rpc.ensurePluginFork({
			base,
			forkId: 'referenced',
			autoStart: true,
			selectFor: {
				consumer,
				requirement: pluginDefinitionAddressOf(ForkProvider),
			},
		})
		if (ensured.ok === false) throw new Error(ensured.error)

		await expect(rpc.removePluginFork({ base, forkId: 'referenced' })).resolves.toMatchObject({
			ok: false,
			code: 'fork_referenced',
			state: 'unchanged',
			references: [
				{
					consumer,
					requirement: pluginDefinitionAddressOf(ForkProvider),
				},
			],
		})
		expect(host.isRunning(ensured.fork)).toBe(false)

		await expect(
			rpc.setPluginConsumerOverride({
				consumer,
				requirement: pluginDefinitionAddressOf(ForkProvider),
				provider: null,
			}),
		).resolves.toMatchObject({ ok: true, status: 'applied', report: {} })
		const business = host.ctx.require(Persistence).namespace('plugin-business')
		await business.put('referenced/data.json', '{"retained":true}')

		const removed = await rpc.removePluginFork({ base, forkId: 'referenced' })
		expect(removed).toMatchObject({ ok: true, status: 'removed', fork: ensured.fork, report: {} })
		if (removed.ok && removed.status !== 'already-absent') {
			expectBrowserSafeReport(removed.report)
		}
		expect(await business.getText('referenced/data.json')).toBe('{"retained":true}')
		expect(listForkIds(requireHostStateStore(host.ctx).snapshot(), base.definition)).not.toContain(
			'referenced',
		)

		await expect(rpc.removePluginFork({ base, forkId: 'referenced' })).resolves.toMatchObject({
			ok: true,
			status: 'already-absent',
			fork: ensured.fork,
		})
	})

	it('retains drain lifecycle issues in the final browser report', async () => {
		const host = await runtimeHost()
		host.add(DrainFailureForkProvider)
		await host.commit()
		const rpc = new RuntimeManagementTargetImpl(host.ctx)
		const base = pluginNodeAddressOf(DrainFailureForkProvider)
		const ensured = await rpc.ensurePluginFork({ base, forkId: 'drain', autoStart: true })
		if (ensured.ok === false) throw new Error(ensured.error)
		await expect(
			rpc.applyPluginLifecycleCommands([{ address: ensured.fork, command: 'start' }]),
		).resolves.toMatchObject({ results: [{ ok: true }] })
		expect(host.isRunning(ensured.fork)).toBe(true)

		const removed = await rpc.removePluginFork({ base, forkId: 'drain' })
		expect(removed).toMatchObject({
			ok: true,
			status: 'removed-with-lifecycle-issues',
			report: {
				core: {
					status: 'committed',
					summary: {
						lifecycleReport: {
							ok: false,
							issues: [{ plugin: ensured.fork, phase: 'drain', kind: 'drain-failed' }],
						},
					},
				},
			},
		})
		if (removed.ok && removed.status !== 'already-absent') {
			expectBrowserSafeReport(removed.report)
		}
	})

	it('returns stopped-retained when readonly Config metadata rejects removal', async () => {
		const host = await runtimeHost({
			configRecords: {
				mode: 'readonly',
				storage: createMemoryPersistenceBackend().namespace('config'),
			},
		})
		host.add(ForkProvider)
		await host.commit()
		const rpc = new RuntimeManagementTargetImpl(host.ctx)
		const base = pluginNodeAddressOf(ForkProvider)
		const ensured = await rpc.ensurePluginFork({ base, forkId: 'readonly', autoStart: true })
		if (ensured.ok === false) throw new Error(ensured.error)

		await expect(rpc.removePluginFork({ base, forkId: 'readonly' })).resolves.toMatchObject({
			ok: false,
			code: 'persistence_failed',
			state: 'stopped-retained',
			fork: ensured.fork,
			report: {},
		})
		const state = requireHostStateStore(host.ctx).snapshot()
		expect(listForkIds(state, base.definition)).toContain('readonly')
		expect(isPluginAutoStartEnabled(state, ensured.fork)).toBe(true)
	})

	it('retries a failed Config cleanup and never purges business persistence', async () => {
		const delegate = createMemoryPersistenceBackend()
		let rejectConfigWrite = false
		const backend: PersistenceBackend = {
			capability: delegate.capability,
			preflight: delegate.preflight,
			namespace(name) {
				const storage = delegate.namespace(name)
				return {
					...storage,
					async put(key, value, options) {
						if (rejectConfigWrite && name === 'config' && key === 'config.json') {
							throw new Error('config cleanup unavailable')
						}
						await storage.put(key, value, options)
					},
				}
			},
		}
		const host = await runtimeHost({
			services: standardServices({ persistence: { mode: 'custom', backend } }),
			configRecords: { storage: backend.namespace('config') },
		})
		host.add(ForkProvider)
		await host.commit()
		const rpc = new RuntimeManagementTargetImpl(host.ctx)
		const base = pluginNodeAddressOf(ForkProvider)
		const ensured = await rpc.ensurePluginFork({ base, forkId: 'retry', autoStart: true })
		if (ensured.ok === false) throw new Error(ensured.error)
		const config = requireConfigService(host.ctx)
		config.patchConfig(ensured.fork, { desired: true })
		await config.flush()
		const business = host.ctx.require(Persistence).namespace('plugin-business')
		await business.put('retry/data.bin', 'business-state')

		rejectConfigWrite = true
		await expect(rpc.removePluginFork({ base, forkId: 'retry' })).resolves.toMatchObject({
			ok: false,
			code: 'persistence_failed',
			state: 'stopped-retained',
			fork: ensured.fork,
		})
		let state = requireHostStateStore(host.ctx).snapshot()
		expect(listForkIds(state, base.definition)).toContain('retry')
		expect(isPluginAutoStartEnabled(state, ensured.fork)).toBe(true)
		expect(await business.getText('retry/data.bin')).toBe('business-state')

		rejectConfigWrite = false
		await expect(rpc.removePluginFork({ base, forkId: 'retry' })).resolves.toMatchObject({
			ok: true,
			status: 'removed',
		})
		state = requireHostStateStore(host.ctx).snapshot()
		expect(listForkIds(state, base.definition)).not.toContain('retry')
		expect(await business.getText('retry/data.bin')).toBe('business-state')
	})

	it('retries a failed logging-policy cleanup before removing durable fork intent', async () => {
		let rejectLoggingWrite = false
		const persisted: Parameters<PluginLogPolicyStore['save']>[1][] = []
		const loggingStore: PluginLogPolicyStore = {
			load: async () => undefined,
			save: async (_profile, snapshot) => {
				if (rejectLoggingWrite) throw new Error('logging cleanup unavailable')
				persisted.push(snapshot)
			},
		}
		const host = await createServiceInternalTestHarness({
			workbench: false,
			services: [
				...standardServices({ persistence: { mode: 'memory' } }),
				loggingService(loggingPlan(), { policyStore: loggingStore }),
			],
		})
		const logging = host.ctx.require(Logging)
		hosts.push(host)
		try {
			host.add(ForkProvider)
			await host.commit()
			const rpc = new RuntimeManagementTargetImpl(host.ctx)
			const base = pluginNodeAddressOf(ForkProvider)
			const ensured = await rpc.ensurePluginFork({ base, forkId: 'logging-retry', autoStart: true })
			if (ensured.ok === false) throw new Error(ensured.error)
			logging.policy.setPluginLevel(ensured.fork, 'debug')
			await logging.policy.flush()
			expect(persisted.at(-1)?.overrides).toMatchObject([{ owner: ensured.fork, level: 'debug' }])

			rejectLoggingWrite = true
			await expect(rpc.removePluginFork({ base, forkId: 'logging-retry' })).resolves.toMatchObject({
				ok: false,
				code: 'persistence_failed',
				state: 'stopped-retained',
				fork: ensured.fork,
			})
			let state = requireHostStateStore(host.ctx).snapshot()
			expect(listForkIds(state, base.definition)).toContain('logging-retry')
			expect(isPluginAutoStartEnabled(state, ensured.fork)).toBe(true)
			expect(logging.policy.persistence).toBe('failed')

			rejectLoggingWrite = false
			await expect(rpc.removePluginFork({ base, forkId: 'logging-retry' })).resolves.toMatchObject({
				ok: true,
				status: 'removed',
			})
			state = requireHostStateStore(host.ctx).snapshot()
			expect(listForkIds(state, base.definition)).not.toContain('logging-retry')
			expect(logging.policy.persistence).toBe('clean')
			expect(persisted.at(-1)?.overrides).toEqual([])
		} finally {
			await host.dispose()
		}
	})
})

async function runtimeHost(
	config: Parameters<typeof createServiceInternalTestHarness>[0] = {},
): Promise<ServiceInternalTestHarness> {
	const host = await createServiceInternalTestHarness({ workbench: false, ...config })
	hosts.push(host)
	return host
}

function expectBrowserSafeReport(report: PluginApplyReport): void {
	expect(() => JSON.stringify(report)).not.toThrow()
	const visit = (value: unknown): void => {
		if (!value || typeof value !== 'object') return
		expect(Object.isFrozen(value)).toBe(true)
		expect(Object.getOwnPropertySymbols(value)).toEqual([])
		expect(Object.hasOwn(value, 'graph')).toBe(false)
		for (const child of Object.values(value)) visit(child)
	}
	visit(report)
}

function loggingPlan(): RuntimeLoggingInput {
	return {
		root: { profile: 'fork-removal-test' },
		sinks: {
			store: {
				kind: 'store',
				streamId: 'fork-removal-test',
				bufferSize: 1,
				flushIntervalMs: 0,
				caller: false,
			},
		},
		routes: {
			runtime: [{ sink: 'store', minLevel: 'fatal' }],
			plugins: [{ sink: 'store', minLevel: 'fatal' }],
			debug: [],
			meta: [],
		},
	}
}
