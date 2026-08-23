import {
	pluginDefinitionAddressOf,
	pluginNodeAddressOf,
	pluginNodeAddressEqual,
} from '@pluxel/core'
import { requireConfigService } from '@pluxel/core/internal'
import { BasePlugin, createRuntimeHost, Plugin, type RuntimeHost } from '@pluxel/runtime/test'
import { afterEach, describe, expect, it } from 'vitest'
import { RuntimeRpcApi } from '../../src/api/http/rpc/RuntimeRpcApi'
import { requireRuntimeStateStore } from '../../src/internal/runtime-state'
import { createRuntimeLogging, type RuntimeLoggingInput } from '../../src/logger/logging'
import type { PluginLogPolicyStore } from '../../src/logger/policy'
import { isPluginEnabled, listForkIds } from '../../src/services/RuntimeStateHelpers'
import {
	createMemoryPersistenceBackend,
	type PersistenceBackend,
} from '../../src/services/persistence/PersistenceService'
import type { PluginApplyReport } from '../../src/web/protocol'

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

const hosts: RuntimeHost[] = []

afterEach(async () => {
	for (const host of hosts.splice(0)) await host.dispose()
})

describe('Plugin fork control plane', () => {
	it('atomically creates, enables, and selects a fork with an address-only report', async () => {
		const host = runtimeHost()
		host.add([ForkProvider, ForkConsumer])
		await host.commit()
		const rpc = new RuntimeRpcApi(host.ctx)
		const base = pluginNodeAddressOf(ForkProvider)
		const consumer = pluginNodeAddressOf(ForkConsumer)

		const result = await rpc.ensurePluginFork({
			base,
			forkId: 'atomic',
			enable: true,
			selectFor: {
				consumer,
				requirement: pluginDefinitionAddressOf(ForkProvider),
			},
		})

		expect(result).toMatchObject({
			ok: true,
			status: 'applied',
			fork: { variant: 'fork', forkId: 'atomic' },
			report: { core: { status: 'committed' } },
		})
		if (result.ok === false) throw new Error(result.error)
		const state = requireRuntimeStateStore(host.ctx).snapshot()
		expect(listForkIds(state, base.definition)).toContain('atomic')
		expect(isPluginEnabled(state, result.fork)).toBe(true)
		expect(state.dependencyOverrides).toHaveLength(1)
		expect(pluginNodeAddressEqual(state.dependencyOverrides[0]!.providerAddress, result.fork)).toBe(
			true,
		)
		expectBrowserSafeReport(result.report)
	})

	it('rejects an invalid atomic selection without leaving fork intent behind', async () => {
		const host = runtimeHost()
		host.add([ForkProvider, ForkConsumer])
		await host.commit()
		const rpc = new RuntimeRpcApi(host.ctx)
		const base = pluginNodeAddressOf(ForkProvider)

		await expect(
			rpc.ensurePluginFork({
				base,
				forkId: 'must-not-survive',
				enable: true,
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
		const state = requireRuntimeStateStore(host.ctx).snapshot()
		expect(listForkIds(state, base.definition)).not.toContain('must-not-survive')
		expect(state.dependencyOverrides).toEqual([])
	})

	it('reports applied, deferred, and saved-not-applied ensure outcomes with reports', async () => {
		const host = runtimeHost()
		host.add([ForkProvider, FailingForkProvider])
		await host.commit()
		const rpc = new RuntimeRpcApi(host.ctx)

		const applied = await rpc.ensurePluginFork({
			base: pluginNodeAddressOf(ForkProvider),
			forkId: 'running',
			enable: true,
		})
		expect(applied).toMatchObject({ ok: true, status: 'applied', report: {} })
		if (applied.ok) expectBrowserSafeReport(applied.report)

		const deferred = await rpc.ensurePluginFork({
			base: pluginNodeAddressOf(ForkProvider),
			forkId: 'disabled',
			enable: false,
		})
		expect(deferred).toMatchObject({ ok: true, status: 'deferred', report: {} })
		if (deferred.ok) expectBrowserSafeReport(deferred.report)

		const failed = await rpc.ensurePluginFork({
			base: pluginNodeAddressOf(FailingForkProvider),
			forkId: 'failing',
			enable: true,
		})
		expect(failed).toMatchObject({
			ok: true,
			status: 'saved-not-applied',
			applicationFailure: { code: 'plugin_not_running_after_enable' },
			report: {
				core: {
					status: 'committed',
					summary: { lifecycleReport: { ok: false } },
				},
			},
		})
		if (failed.ok) expectBrowserSafeReport(failed.report)
	})

	it('blocks inbound references, removes after clearing them, and is idempotent', async () => {
		const host = runtimeHost()
		host.add([ForkProvider, ForkConsumer])
		await host.commit()
		const rpc = new RuntimeRpcApi(host.ctx)
		const base = pluginNodeAddressOf(ForkProvider)
		const consumer = pluginNodeAddressOf(ForkConsumer)
		const ensured = await rpc.ensurePluginFork({
			base,
			forkId: 'referenced',
			enable: true,
			selectFor: {
				consumer,
				requirement: pluginDefinitionAddressOf(ForkProvider),
			},
		})
		if (!ensured.ok) throw new Error(ensured.error)

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
		expect(host.isRunning(ensured.fork)).toBe(true)

		await expect(
			rpc.setPluginDependencyTarget({
				consumer,
				requirement: pluginDefinitionAddressOf(ForkProvider),
				provider: null,
			}),
		).resolves.toMatchObject({ ok: true, status: 'applied', report: {} })
		const business = host.ctx.root.persistence.namespace('plugin-business')
		await business.put('referenced/data.json', '{"retained":true}')

		const removed = await rpc.removePluginFork({ base, forkId: 'referenced' })
		expect(removed).toMatchObject({ ok: true, status: 'removed', fork: ensured.fork, report: {} })
		if (removed.ok && removed.status !== 'already-absent') {
			expectBrowserSafeReport(removed.report)
		}
		expect(await business.getText('referenced/data.json')).toBe('{"retained":true}')
		expect(
			listForkIds(requireRuntimeStateStore(host.ctx).snapshot(), base.definition),
		).not.toContain('referenced')

		await expect(rpc.removePluginFork({ base, forkId: 'referenced' })).resolves.toMatchObject({
			ok: true,
			status: 'already-absent',
			fork: ensured.fork,
		})
	})

	it('retains drain lifecycle issues in the final browser report', async () => {
		const host = runtimeHost()
		host.add(DrainFailureForkProvider)
		await host.commit()
		const rpc = new RuntimeRpcApi(host.ctx)
		const base = pluginNodeAddressOf(DrainFailureForkProvider)
		const ensured = await rpc.ensurePluginFork({ base, forkId: 'drain', enable: true })
		if (!ensured.ok) throw new Error(ensured.error)

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

	it('returns disabled-retained when readonly Config metadata rejects removal', async () => {
		const host = runtimeHost({ configService: { mode: 'readonly' } })
		host.add(ForkProvider)
		await host.commit()
		const rpc = new RuntimeRpcApi(host.ctx)
		const base = pluginNodeAddressOf(ForkProvider)
		const ensured = await rpc.ensurePluginFork({ base, forkId: 'readonly', enable: true })
		if (!ensured.ok) throw new Error(ensured.error)

		await expect(rpc.removePluginFork({ base, forkId: 'readonly' })).resolves.toMatchObject({
			ok: false,
			code: 'persistence_failed',
			state: 'disabled-retained',
			fork: ensured.fork,
			report: {},
		})
		const state = requireRuntimeStateStore(host.ctx).snapshot()
		expect(listForkIds(state, base.definition)).toContain('readonly')
		expect(isPluginEnabled(state, ensured.fork)).toBe(false)
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
		const host = runtimeHost({
			persistence: { mode: 'custom', backend },
			configService: { mode: 'file' },
		})
		host.add(ForkProvider)
		await host.commit()
		const rpc = new RuntimeRpcApi(host.ctx)
		const base = pluginNodeAddressOf(ForkProvider)
		const ensured = await rpc.ensurePluginFork({ base, forkId: 'retry', enable: true })
		if (!ensured.ok) throw new Error(ensured.error)
		const config = requireConfigService(host.ctx)
		config.patchConfig(ensured.fork, { desired: true })
		await config.flush()
		const business = host.ctx.root.persistence.namespace('plugin-business')
		await business.put('retry/data.bin', 'business-state')

		rejectConfigWrite = true
		await expect(rpc.removePluginFork({ base, forkId: 'retry' })).resolves.toMatchObject({
			ok: false,
			code: 'persistence_failed',
			state: 'disabled-retained',
			fork: ensured.fork,
		})
		let state = requireRuntimeStateStore(host.ctx).snapshot()
		expect(listForkIds(state, base.definition)).toContain('retry')
		expect(isPluginEnabled(state, ensured.fork)).toBe(false)
		expect(await business.getText('retry/data.bin')).toBe('business-state')

		rejectConfigWrite = false
		await expect(rpc.removePluginFork({ base, forkId: 'retry' })).resolves.toMatchObject({
			ok: true,
			status: 'removed',
		})
		state = requireRuntimeStateStore(host.ctx).snapshot()
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
		const logging = createRuntimeLogging(loggingPlan())
		await logging.install()
		await logging.initializePolicy(loggingStore)
		const host = createRuntimeHost(
			{ workbench: false, logger: logging.contextBinding },
			{ logging },
		)
		hosts.push(host)
		try {
			host.add(ForkProvider)
			await host.commit()
			const rpc = new RuntimeRpcApi(host.ctx)
			const base = pluginNodeAddressOf(ForkProvider)
			const ensured = await rpc.ensurePluginFork({ base, forkId: 'logging-retry', enable: true })
			if (!ensured.ok) throw new Error(ensured.error)
			logging.policy.setPluginLevel(ensured.fork, 'debug')
			await logging.policy.flush()
			expect(persisted.at(-1)?.overrides).toMatchObject([{ owner: ensured.fork, level: 'debug' }])

			rejectLoggingWrite = true
			await expect(rpc.removePluginFork({ base, forkId: 'logging-retry' })).resolves.toMatchObject({
				ok: false,
				code: 'persistence_failed',
				state: 'disabled-retained',
				fork: ensured.fork,
			})
			let state = requireRuntimeStateStore(host.ctx).snapshot()
			expect(listForkIds(state, base.definition)).toContain('logging-retry')
			expect(isPluginEnabled(state, ensured.fork)).toBe(false)
			expect(logging.policy.persistence).toBe('failed')

			rejectLoggingWrite = false
			await expect(rpc.removePluginFork({ base, forkId: 'logging-retry' })).resolves.toMatchObject({
				ok: true,
				status: 'removed',
			})
			state = requireRuntimeStateStore(host.ctx).snapshot()
			expect(listForkIds(state, base.definition)).not.toContain('logging-retry')
			expect(logging.policy.persistence).toBe('clean')
			expect(persisted.at(-1)?.overrides).toEqual([])
		} finally {
			await host.dispose()
			await logging.dispose()
		}
	})
})

function runtimeHost(config: Parameters<typeof createRuntimeHost>[0] = {}): RuntimeHost {
	const host = createRuntimeHost({ workbench: false, ...config })
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
