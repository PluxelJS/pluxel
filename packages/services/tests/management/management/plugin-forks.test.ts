import { requireFs, pluginNodePhysicalKey } from '@pluxel/core/internal'
import { requireHostStateStore, isPluginAutoStartEnabled, listForkIds } from '@pluxel/host/internal'
import { standardServices } from '@pluxel/services'
import { logtape } from '@pluxel/core/config'
import { pluginNodeAddressEqual } from '@pluxel/core'
import {
	createServiceInternalTestHarness,
	type ServiceInternalTestHarness,
} from '@pluxel/services/internal/test'
import { BasePlugin, Plugin } from '@pluxel/core/internal/test'
import { afterEach, describe, expect, it } from 'vitest'
import * as v from 'valibot'
import { pluginConfigPatch } from '../../../src/management/api/usecases/pluginConfig'
import { RpcStub } from 'capnweb'
import { createRuntimeManagementClient } from '../../../src/management/web/client'
import { RuntimeManagementTargetImpl } from '../../../src/management/services/management/RuntimeManagementTarget.ts'
import {
	Logging,
	createPluginLogPolicyStore,
	parsePluginLogPolicySnapshot,
	type PluginLogPolicySnapshot,
	type RuntimeLoggingInput,
} from '@pluxel/core/logging'
import {
	parsePluginCatalogSnapshot,
	parseEnsureForkResult,
	parseRemoveForkResult,
	parsePluginDependencyMutationResult,
} from '../../../src/management/web/management-validation'
import { type PluginApplyReport } from '../../../src/management/web/protocol.ts'

@Plugin({ forkable: true })
class ForkProvider extends BasePlugin {
	readonly config = this.configs.use(v.object({ desired: v.optional(v.boolean(), false) }))
}

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

abstract class PolicyToken extends BasePlugin {}
@Plugin(PolicyToken)
class PolicyProvider extends PolicyToken {}

const hosts: ServiceInternalTestHarness[] = []

afterEach(async () => {
	for (const host of hosts.splice(0)) await host.dispose()
})

describe('Plugin fork control plane', () => {
	it('round-trips complete fork targets and preserves omitted autoStart through Management', async () => {
		const host = await runtimeHost()
		host.add([ForkProvider])
		await host.commit()
		using remote = new RpcStub(new RuntimeManagementTargetImpl(host.ctx))
		const client = createRuntimeManagementClient(remote)
		const fork = ForkProvider.nodeAddress('retained')
		expect(await client.forks.ensure({ fork, autoStart: true })).toMatchObject({ ok: true, fork })
		expect(await client.forks.ensure({ fork })).toMatchObject({ ok: true, fork })
		expect(isPluginAutoStartEnabled(requireHostStateStore(host.ctx).snapshot(), fork)).toBe(true)
		expect(await client.forks.ensure({ fork, autoStart: false })).toMatchObject({ ok: true })
		expect(isPluginAutoStartEnabled(requireHostStateStore(host.ctx).snapshot(), fork)).toBe(false)
		expect(await client.forks.remove(fork)).toMatchObject({ ok: true, status: 'removed', fork })
		expect(await client.forks.remove(fork)).toMatchObject({
			ok: true,
			status: 'already-absent',
			fork,
		})
	})

	it('rejects default, malformed, and obsolete fork inputs at the RPC boundary', async () => {
		const host = await runtimeHost()
		host.add([ForkProvider])
		await host.commit()
		const rpc = new RuntimeManagementTargetImpl(host.ctx)
		const expected = { ok: false, code: 'invalid_input', state: 'unchanged' }
		for (const fork of [
			ForkProvider.nodeAddress(),
			{ ...ForkProvider.nodeAddress('bad'), forkId: '' },
		]) {
			expect(parseEnsureForkResult(await rpc.ensurePluginForkDto({ fork }))).toMatchObject(expected)
			expect(parseRemoveForkResult(await rpc.removePluginForkDto(fork))).toMatchObject(expected)
		}
		const obsolete = { base: ForkProvider.nodeAddress(), forkId: 'obsolete' }
		expect(parseEnsureForkResult(await rpc.ensurePluginForkDto(obsolete))).toMatchObject(expected)
		expect(parseRemoveForkResult(await rpc.removePluginForkDto(obsolete))).toMatchObject(expected)
		expect(
			listForkIds(requireHostStateStore(host.ctx).snapshot(), ForkProvider.definitionAddress()),
		).toEqual([])
		expect(() =>
			parseRemoveForkResult({
				ok: true,
				status: 'already-absent',
				fork: ForkProvider.nodeAddress(),
			}),
		).toThrow(/fork node address/)
	})
	it('preserves policy_shadowed through management DTOs and receiver validation', async () => {
		await using host = await createServiceInternalTestHarness({
			workbench: false,
			management: true,
			policy: {
				autoStart: [],
				forks: [ForkProvider.nodeAddress('locked')],
				providerDefaults: [],
				dependencyOverrides: [],
			},
		})
		host.add([ForkProvider, ForkConsumer, PolicyProvider])
		await host.commit()
		const rpc = new RuntimeManagementTargetImpl(host.ctx)
		expect(parsePluginCatalogSnapshot(await rpc.pluginCatalogDto()).statePolicy).toEqual({
			readonly: false,
			managedRevision: expect.any(String),
			overriddenFields: ['autoStart', 'forks', 'providerDefaults', 'dependencyOverrides'],
		})
		const expected = { ok: false, code: 'policy_shadowed', state: 'unchanged' }
		const base = ForkProvider.nodeAddress()
		expect(
			parseEnsureForkResult(
				await rpc.ensurePluginForkDto({
					fork: ForkProvider.nodeAddress('locked'),
				}),
			),
		).toMatchObject({
			ok: true,
			status: 'deferred',
			report: { persistence: { status: 'unchanged' }, writtenFields: [] },
		})
		expect(
			parseRemoveForkResult(await rpc.removePluginForkDto(ForkProvider.nodeAddress('locked'))),
		).toMatchObject(expected)
		expect(await rpc.setPluginAutoStartDto([{ address: base, autoStart: true }])).toMatchObject({
			ok: false,
			results: [expected],
		})
		expect(
			parsePluginDependencyMutationResult(
				await rpc.setPluginConsumerOverrideDto({
					consumer: ForkConsumer.nodeAddress(),
					requirement: ForkProvider.definitionAddress(),
					provider: base,
				}),
			),
		).toMatchObject(expected)
		expect(
			parsePluginDependencyMutationResult(
				await rpc.setPluginProviderPolicyDefaultDto({
					policyOwner: PolicyProvider.nodeAddress(),
					provider: PolicyProvider.nodeAddress(),
				}),
			),
		).toMatchObject(expected)
	})

	it('atomically creates, marks for auto-start, and selects a fork without starting it live', async () => {
		const host = await runtimeHost()
		host.add([ForkProvider, ForkConsumer])
		await host.commit()
		const rpc = new RuntimeManagementTargetImpl(host.ctx)
		const base = ForkProvider.nodeAddress()
		const consumer = ForkConsumer.nodeAddress()

		const result = await rpc.ensurePluginForkDto({
			fork: ForkProvider.nodeAddress('atomic'),
			autoStart: true,
			selectFor: {
				consumer,
				requirement: ForkProvider.definitionAddress(),
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
		const base = ForkProvider.nodeAddress()

		await expect(
			rpc.ensurePluginForkDto({
				fork: ForkProvider.nodeAddress('must-not-survive'),
				autoStart: true,
				selectFor: {
					consumer: ForkConsumer.nodeAddress(),
					requirement: FailingForkProvider.definitionAddress(),
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
		const consumer = ForkConsumer.nodeAddress()

		const applied = await rpc.ensurePluginForkDto({
			fork: ForkProvider.nodeAddress('running'),
			autoStart: false,
			selectFor: {
				consumer,
				requirement: ForkProvider.definitionAddress(),
			},
		})
		expect(applied).toMatchObject({ ok: true, status: 'applied', report: {} })
		if (applied.ok) expectBrowserSafeReport(applied.report)

		const deferred = await rpc.ensurePluginForkDto({
			fork: ForkProvider.nodeAddress('dormant'),
			autoStart: false,
		})
		expect(deferred).toMatchObject({ ok: true, status: 'deferred', report: {} })
		if (deferred.ok) expectBrowserSafeReport(deferred.report)

		const nextBoot = await rpc.ensurePluginForkDto({
			fork: FailingForkProvider.nodeAddress('failing'),
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
		const base = ForkProvider.nodeAddress()
		const consumer = ForkConsumer.nodeAddress()
		const ensured = await rpc.ensurePluginForkDto({
			fork: ForkProvider.nodeAddress('referenced'),
			autoStart: true,
			selectFor: {
				consumer,
				requirement: ForkProvider.definitionAddress(),
			},
		})
		if (ensured.ok === false) throw new Error(ensured.error)

		await expect(
			rpc.removePluginForkDto(ForkProvider.nodeAddress('referenced')),
		).resolves.toMatchObject({
			ok: false,
			code: 'fork_referenced',
			state: 'unchanged',
			references: [
				{
					consumer,
					requirement: ForkProvider.definitionAddress(),
				},
			],
		})
		expect(host.isRunning(ensured.fork)).toBe(false)

		await expect(
			rpc.setPluginConsumerOverrideDto({
				consumer,
				requirement: ForkProvider.definitionAddress(),
				provider: null,
			}),
		).resolves.toMatchObject({ ok: true, status: 'applied', report: {} })
		const business = await requireFs(host.ctx).directory(
			`plugins/${pluginNodePhysicalKey(ensured.fork)}`,
		)
		await business.mkdir('referenced', { recursive: true })
		await business.writeFile('referenced/data.json', '{"retained":true}')

		const removed = await rpc.removePluginForkDto(ForkProvider.nodeAddress('referenced'))
		expect(removed).toMatchObject({ ok: true, status: 'removed', fork: ensured.fork, report: {} })
		if (removed.ok && removed.status !== 'already-absent') {
			expectBrowserSafeReport(removed.report)
		}
		expect(await business.readFile('referenced/data.json', 'utf8')).toBe('{"retained":true}')
		expect(listForkIds(requireHostStateStore(host.ctx).snapshot(), base.definition)).not.toContain(
			'referenced',
		)

		await expect(
			rpc.removePluginForkDto(ForkProvider.nodeAddress('referenced')),
		).resolves.toMatchObject({
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
		const ensured = await rpc.ensurePluginForkDto({
			fork: DrainFailureForkProvider.nodeAddress('drain'),
			autoStart: true,
		})
		if (ensured.ok === false) throw new Error(ensured.error)
		await expect(
			rpc.applyPluginLifecycleCommandsDto([{ address: ensured.fork, command: 'start' }]),
		).resolves.toMatchObject({ results: [{ ok: true }] })
		expect(host.isRunning(ensured.fork)).toBe(true)

		const removed = await rpc.removePluginForkDto(DrainFailureForkProvider.nodeAddress('drain'))
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

	it('rejects readonly Config metadata removal before stopping the fork', async () => {
		const host = await runtimeHost({
			runtime: {
				documents: {
					config: { readOnly: true, storage: (root) => requireFs(root).documents('host/config') },
				},
			},
		})
		host.add(ForkProvider)
		await host.commit()
		const rpc = new RuntimeManagementTargetImpl(host.ctx)
		const base = ForkProvider.nodeAddress()
		const ensured = await rpc.ensurePluginForkDto({
			fork: ForkProvider.nodeAddress('readonly'),
			autoStart: true,
		})
		if (ensured.ok === false) throw new Error(ensured.error)
		await rpc.applyPluginLifecycleCommandsDto([{ address: ensured.fork, command: 'start' }])

		await expect(
			rpc.removePluginForkDto(ForkProvider.nodeAddress('readonly')),
		).resolves.toMatchObject({
			ok: false,
			code: 'mutation_rejected',
			state: 'unchanged',
		})
		const state = requireHostStateStore(host.ctx).snapshot()
		expect(listForkIds(state, base.definition)).toContain('readonly')
		expect(isPluginAutoStartEnabled(state, ensured.fork)).toBe(true)
		expect(host.isRunning(ensured.fork)).toBe(true)
	})

	it('retries a failed Config cleanup and never purges business persistence', async () => {
		let rejectConfigWrite = false
		const host = await runtimeHost({
			services: standardServices(),
			runtime: {
				documents: {
					config: {
						storage(root) {
							const documents = requireFs(root).documents('host/config')
							return {
								getText: (key) => documents.getText(key),
								stat: (key) => documents.stat(key),
								async put(key, value) {
									if (rejectConfigWrite && key === 'config.json')
										throw new Error('config cleanup unavailable')
									await documents.put(key, value)
								},
							}
						},
					},
				},
			},
		})
		host.add(ForkProvider)
		await host.commit()
		const rpc = new RuntimeManagementTargetImpl(host.ctx)
		const base = ForkProvider.nodeAddress()
		const ensured = await rpc.ensurePluginForkDto({
			fork: ForkProvider.nodeAddress('retry'),
			autoStart: true,
		})
		if (ensured.ok === false) throw new Error(ensured.error)
		await expect(
			pluginConfigPatch(host.ctx, ensured.fork, { set: { desired: true } }),
		).resolves.toMatchObject({ ok: true })
		const business = await requireFs(host.ctx).directory(
			`plugins/${pluginNodePhysicalKey(ensured.fork)}`,
		)
		await business.mkdir('retry', { recursive: true })
		await business.writeFile('retry/data.bin', 'business-state')

		rejectConfigWrite = true
		await expect(rpc.removePluginForkDto(ForkProvider.nodeAddress('retry'))).resolves.toMatchObject(
			{
				ok: false,
				code: 'persistence_failed',
				state: 'stopped-retained',
				fork: ensured.fork,
			},
		)
		let state = requireHostStateStore(host.ctx).snapshot()
		expect(listForkIds(state, base.definition)).toContain('retry')
		expect(isPluginAutoStartEnabled(state, ensured.fork)).toBe(true)
		expect(await business.readFile('retry/data.bin', 'utf8')).toBe('business-state')

		rejectConfigWrite = false
		await expect(rpc.removePluginForkDto(ForkProvider.nodeAddress('retry'))).resolves.toMatchObject(
			{
				ok: true,
				status: 'removed',
			},
		)
		state = requireHostStateStore(host.ctx).snapshot()
		expect(listForkIds(state, base.definition)).not.toContain('retry')
		expect(await business.readFile('retry/data.bin', 'utf8')).toBe('business-state')
	})

	it('retries a failed logging-policy cleanup before removing durable fork intent', async () => {
		let rejectLoggingWrite = false
		const persisted: PluginLogPolicySnapshot[] = []
		await using host = await createServiceInternalTestHarness({
			workbench: false,
			services: standardServices(),
			runtime: {
				logtape: logtape(loggingPlan(), {
					policyStore(root) {
						const documents = requireFs(root).documents('services/logging')
						return createPluginLogPolicyStore({
							getText: (key) => documents.getText(key),
							async put(key, value) {
								if (rejectLoggingWrite) throw new Error('logging cleanup unavailable')
								await documents.put(key, value)
								persisted.push(parsePluginLogPolicySnapshot(value))
							},
						})
					},
				}),
			},
		})
		const logging = host.ctx.require(Logging)
		hosts.push(host)

		host.add(ForkProvider)
		await host.commit()
		const rpc = new RuntimeManagementTargetImpl(host.ctx)
		const base = ForkProvider.nodeAddress()
		const ensured = await rpc.ensurePluginForkDto({
			fork: ForkProvider.nodeAddress('logging-retry'),
			autoStart: true,
		})
		if (ensured.ok === false) throw new Error(ensured.error)
		logging.policy.setPluginLevel(ensured.fork, 'debug')
		await logging.policy.flush()
		expect(persisted.at(-1)?.overrides).toMatchObject([{ owner: ensured.fork, level: 'debug' }])

		rejectLoggingWrite = true
		await expect(
			rpc.removePluginForkDto(ForkProvider.nodeAddress('logging-retry')),
		).resolves.toMatchObject({
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
		await expect(
			rpc.removePluginForkDto(ForkProvider.nodeAddress('logging-retry')),
		).resolves.toMatchObject({
			ok: true,
			status: 'removed',
		})
		state = requireHostStateStore(host.ctx).snapshot()
		expect(listForkIds(state, base.definition)).not.toContain('logging-retry')
		expect(logging.policy.persistence).toBe('clean')
		expect(persisted.at(-1)?.overrides).toEqual([])
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
	return ({ createRuntimeLogSink }) => ({
		sinks: {
			store: createRuntimeLogSink({
				streamId: 'fork-removal-test',
				bufferSize: 1,
				flushIntervalMs: 0,
				caller: false,
			}),
		},
		loggers: [
			{ category: ['pluxel', 'runtime'], sinks: ['store'], lowestLevel: 'fatal' },
			{ category: ['pluxel', 'plugins'], sinks: ['store'], lowestLevel: 'fatal' },
			{ category: ['logtape', 'meta'], lowestLevel: null },
		],
	})
}
