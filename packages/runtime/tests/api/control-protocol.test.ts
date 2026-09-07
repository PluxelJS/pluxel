import { requireRuntimePluginGraphCoordinator } from '@pluxel/runtime/internal'
import { createRuntimeInternalTestHarness } from '@pluxel/runtime/internal/test'
import { pluginDefinitionAddressOf, pluginNodeAddressOf } from '@pluxel/core'
import { BasePlugin, Plugin } from '@pluxel/runtime/test'
import { serialize } from 'capnweb'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { applyLifecycleCommands, setAutoStart } from '../../src/api/usecases/pluginStatus'
import { RuntimeManagementTargetImpl } from '../../src/services/management/RuntimeManagementTarget'
import type {
	ConfigResult,
	ConfigPresentationResult,
	EnsureForkResult,
	PluginDependencyMutationResult,
	PluginApplyReport,
	PluginControlMutationResult,
	PluginLifecycleCommand,
	RemoveForkResult,
} from '../../src/web/protocol'
import { requireRuntimeStateStore } from '../../src/internal/runtime-state'

@Plugin()
class ManagedPlugin extends BasePlugin {}

@Plugin()
class FailingManagedPlugin extends BasePlugin {
	override init(): void {
		throw new Error('fixture startup failed')
	}
}

abstract class ManagedProviderToken extends BasePlugin {}

@Plugin(ManagedProviderToken, { forkable: true })
class ManagedProvider extends ManagedProviderToken {}

@Plugin(ManagedProviderToken)
class ManagedAlternateProvider extends ManagedProviderToken {}

@Plugin()
class ManagedProviderConsumer extends BasePlugin {
	constructor(readonly provider: ManagedProviderToken) {
		super()
	}
}

@Plugin()
class ManagedDirectConsumer extends BasePlugin {
	constructor(readonly provider: ManagedPlugin) {
		super()
	}
}

describe('runtime web control protocol', () => {
	it('exposes only the three process lifecycle commands', () => {
		expectTypeOf<PluginLifecycleCommand>().toEqualTypeOf<'start' | 'stop' | 'restart'>()
	})

	it('keeps expected status and persistence failures closed and state-bearing', async () => {
		const host = createRuntimeInternalTestHarness({ workbench: false })
		try {
			host.add(ManagedPlugin)
			await host.commit()
			const address = host.cfg(ManagedPlugin).owner
			const rpc = new RuntimeManagementTargetImpl(host.ctx)

			const startResult = await rpc.applyPluginLifecycleCommands([{ address, command: 'start' }])
			expect(startResult).toMatchObject({
				ok: true,
				status: 'applied',
				results: [
					{
						address,
						ok: true,
						status: 'applied',
						report: { core: { status: 'committed' } },
						control: {
							autoStart: false,
							sessionIntent: 'run',
							desiredState: 'running',
							activationReason: 'session',
							lifecycleState: 'running',
						},
					},
				],
			})
			expect(() => serialize(startResult)).not.toThrow()

			const stateStore = requireRuntimeStateStore(host.ctx)
			const commitVersioned = stateStore.commitVersioned.bind(stateStore)
			stateStore.commitVersioned = async () => {
				throw new Error('durable store unavailable')
			}
			const persistenceFailure = await rpc.setPluginAutoStart([{ address, autoStart: true }])
			expect(persistenceFailure).toMatchObject({
				ok: false,
				status: 'rejected',
				results: [
					{
						address,
						ok: false,
						code: 'persistence_failed',
						state: 'unknown',
					},
				],
			})
			expect(() => serialize(persistenceFailure)).not.toThrow()
			stateStore.commitVersioned = commitVersioned
		} finally {
			await host.dispose()
		}
	})

	it('returns a serializable lifecycle report when an admitted start fails', async () => {
		const host = createRuntimeInternalTestHarness({ workbench: false })
		try {
			host.add(FailingManagedPlugin)
			await host.commit()
			const address = host.cfg(FailingManagedPlugin).owner
			const rpc = new RuntimeManagementTargetImpl(host.ctx)

			const result = await rpc.applyPluginLifecycleCommands([{ address, command: 'start' }])
			expect(result).toMatchObject({
				ok: true,
				status: 'applied',
				results: [
					{
						address,
						ok: true,
						control: { desiredState: 'running', lifecycleState: 'stopped' },
						report: {
							core: {
								status: 'committed',
								summary: {
									lifecycleReport: {
										ok: false,
										issues: [
											{
												plugin: address,
												kind: 'start-failed',
												error: { message: 'fixture startup failed' },
											},
										],
									},
								},
							},
						},
					},
				],
			})
			expect(() => serialize(result)).not.toThrow()
		} finally {
			await host.dispose()
		}
	})

	it('keeps provider policy on provider content and consumer override on requirement rows', async () => {
		const host = createRuntimeInternalTestHarness({ workbench: false })
		try {
			host.add([ManagedProvider, ManagedAlternateProvider, ManagedProviderConsumer])
			const providerFork = host.fork(ManagedProvider, 'policy-ineligible')
			await host.commit()
			const rpc = new RuntimeManagementTargetImpl(host.ctx)
			const policyOwner = pluginNodeAddressOf(ManagedProvider)
			const alternateProvider = pluginNodeAddressOf(ManagedAlternateProvider)
			const consumer = pluginNodeAddressOf(ManagedProviderConsumer)
			const token = pluginDefinitionAddressOf(ManagedProviderToken)

			await expect(rpc.inspectPluginProviderPolicy(consumer)).resolves.toEqual({
				ok: true,
				value: null,
			})
			await expect(rpc.inspectPluginProviderPolicy(policyOwner)).resolves.toMatchObject({
				ok: true,
				value: {
					token,
					options: expect.arrayContaining([
						expect.objectContaining({ address: policyOwner }),
						expect.objectContaining({ address: alternateProvider }),
					]),
				},
			})
			const providerPolicy = await rpc.inspectPluginProviderPolicy(policyOwner)
			if (!providerPolicy.ok || !providerPolicy.value) {
				throw new Error('expected provider policy')
			}
			expect(
				providerPolicy.value.options.every((option) => option.address.variant === 'default'),
			).toBe(true)
			expect(providerPolicy.value.options).not.toContainEqual(
				expect.objectContaining({ address: providerFork }),
			)
			await expect(rpc.inspectPluginProviderPolicy(providerFork)).resolves.toEqual({
				ok: true,
				value: null,
			})
			await expect(
				rpc.setPluginProviderPolicyDefault({
					consumer,
					token,
					provider: alternateProvider,
				}),
			).resolves.toMatchObject({
				ok: false,
				code: 'invalid_input',
				state: 'unchanged',
			})
			await expect(
				rpc.setPluginProviderPolicyDefault({
					policyOwner: consumer,
					provider: alternateProvider,
				}),
			).resolves.toMatchObject({
				ok: false,
				code: 'provider_policy_unavailable',
				state: 'unchanged',
			})
			const result = await rpc.setPluginProviderPolicyDefault({
				policyOwner,
				provider: alternateProvider,
			})
			expect(result).toMatchObject({ ok: true, status: 'applied', report: {} })
			if (result.ok) expectBrowserSafeReport(result.report)

			await expect(rpc.inspectPluginProviderPolicy(policyOwner)).resolves.toMatchObject({
				ok: true,
				value: { defaultProvider: alternateProvider, policyOwnerIsDefault: false },
			})
			await expect(rpc.inspectPluginProviderPolicy(alternateProvider)).resolves.toMatchObject({
				ok: true,
				value: { defaultProvider: alternateProvider, policyOwnerIsDefault: true },
			})
			await expect(rpc.inspectPluginConsumerRequirements(consumer)).resolves.toMatchObject({
				ok: true,
				items: [
					{ requirement: token, consumerOverride: null, inheritedProvider: alternateProvider },
				],
			})

			await expect(
				rpc.setPluginConsumerOverride({
					consumer,
					requirement: token,
					provider: policyOwner,
				}),
			).resolves.toMatchObject({ ok: true, status: 'applied' })
			await expect(rpc.inspectPluginConsumerRequirements(consumer)).resolves.toMatchObject({
				ok: true,
				items: [
					{
						requirement: token,
						consumerOverride: policyOwner,
						inheritedProvider: alternateProvider,
					},
				],
			})
		} finally {
			await host.dispose()
		}
	})

	it('addresses dependency inspection and mutation by stable requirement identity', async () => {
		const host = createRuntimeInternalTestHarness({ workbench: false })
		try {
			host.add([ManagedPlugin, ManagedProvider, ManagedProviderConsumer, ManagedDirectConsumer])
			await host.commit()
			const rpc = new RuntimeManagementTargetImpl(host.ctx)
			const consumer = pluginNodeAddressOf(ManagedProviderConsumer)
			const requirement = pluginDefinitionAddressOf(ManagedProviderToken)

			const inspection = await rpc.inspectPluginConsumerRequirements(consumer)
			expect(inspection).toMatchObject({ ok: true, items: [{ requirement }] })
			if (!inspection.ok) throw new Error(inspection.error)
			expect(inspection.items[0]).not.toHaveProperty('index')
			expect(inspection.items[0]).not.toHaveProperty('token')
			expect(inspection.items[0]).not.toHaveProperty('effective')
			expect(inspection.items[0]).not.toHaveProperty('isRunning')
			expect(inspection.items[0]).not.toHaveProperty('selected')
			expect(inspection.items[0]).toHaveProperty('consumerOverride', null)

			await expect(
				rpc.inspectPluginConsumerRequirements(pluginNodeAddressOf(ManagedDirectConsumer)),
			).resolves.toMatchObject({
				ok: true,
				items: [
					{
						kind: 'plugin',
						inheritedProvider: pluginNodeAddressOf(ManagedPlugin),
						options: [
							expect.objectContaining({
								address: pluginNodeAddressOf(ManagedPlugin),
							}),
						],
					},
				],
			})

			await expect(
				rpc.setPluginConsumerOverride({ consumer, index: 0, provider: null }),
			).resolves.toMatchObject({ ok: false, code: 'invalid_input', state: 'unchanged' })
			await expect(
				rpc.setPluginConsumerOverride({
					consumer,
					requirement: pluginDefinitionAddressOf(ManagedPlugin),
					provider: null,
				}),
			).resolves.toMatchObject({
				ok: false,
				code: 'requirement_not_found',
				state: 'unchanged',
			})
			await expect(
				rpc.setPluginConsumerOverride({ consumer, requirement, provider: null }),
			).resolves.toMatchObject({ ok: true, status: 'applied', report: {} })
		} finally {
			await host.dispose()
		}
	})

	it('rejects unexpected programming failures instead of classifying their message', async () => {
		const host = createRuntimeInternalTestHarness({ workbench: false })
		try {
			host.add(ManagedPlugin)
			await host.commit()
			const address = host.cfg(ManagedPlugin).owner
			const coordinator = requireRuntimePluginGraphCoordinator(host.ctx)
			const updateRuntimeState = coordinator.updateRuntimeState.bind(coordinator)
			coordinator.updateRuntimeState = (() =>
				Promise.reject(
					new Error('injected programming failure'),
				)) as typeof coordinator.updateRuntimeState

			await expect(setAutoStart(host.ctx, [{ address, autoStart: true }])).rejects.toThrow(
				'injected programming failure',
			)
			coordinator.updateRuntimeState = updateRuntimeState
		} finally {
			await host.dispose()
		}
	})

	it('rejects malformed transport actions before applying any batch item', async () => {
		const host = createRuntimeInternalTestHarness({ workbench: false })
		try {
			host.add(ManagedPlugin)
			await host.commit()
			const address = host.cfg(ManagedPlugin).owner
			const rpc = new RuntimeManagementTargetImpl(host.ctx)

			await expect(
				rpc.applyPluginLifecycleCommands([
					{ address, command: 'start' },
					{ address, command: 'enable' },
				]),
			).resolves.toEqual({
				ok: false,
				status: 'rejected',
				code: 'invalid_input',
				state: 'unchanged',
				error: 'Plugin lifecycle command at index 1 is invalid',
				results: [],
			})
			await expect(
				rpc.applyPluginLifecycleCommands([{ address: { variant: 'default' }, command: 'start' }]),
			).resolves.toMatchObject({
				ok: false,
				status: 'rejected',
				code: 'invalid_input',
				state: 'unchanged',
				results: [],
			})
			await expect(
				rpc.applyPluginLifecycleCommands([{ address, action: 'enable' }]),
			).resolves.toMatchObject({
				ok: false,
				code: 'invalid_input',
				state: 'unchanged',
				results: [],
			})
			await expect(
				rpc.setPluginAutoStart([{ address, autoStart: true, enabled: true }]),
			).resolves.toMatchObject({
				ok: false,
				code: 'invalid_input',
				state: 'unchanged',
				results: [],
			})
			await expect(
				rpc.patchPluginConfigField(address, {
					fieldPath: '__proto__.polluted',
					value: true,
				}),
			).resolves.toMatchObject({
				ok: false,
				code: 'invalid_input',
				state: 'unchanged',
			})
			expect(
				requireRuntimePluginGraphCoordinator(host.ctx).catalogSnapshot().byDefinition.size,
			).toBe(1)
		} finally {
			await host.dispose()
		}
	})

	it('returns closed invalid-input results for every Plugin RPC boundary', async () => {
		const host = createRuntimeInternalTestHarness({ workbench: false })
		try {
			const rpc = new RuntimeManagementTargetImpl(host.ctx)
			const invalidNode = { variant: 'default' }
			await expect(rpc.pluginConfigPresentation(invalidNode)).resolves.toMatchObject({
				ok: false,
				code: 'invalid_input',
			})
			await expect(rpc.pluginConfig(invalidNode)).resolves.toMatchObject({
				ok: false,
				code: 'invalid_input',
				state: 'unchanged',
			})
			await expect(rpc.patchPluginConfig(invalidNode, null)).resolves.toMatchObject({
				ok: false,
				code: 'invalid_input',
				state: 'unchanged',
			})
			await expect(rpc.patchPluginConfigField(invalidNode, null)).resolves.toMatchObject({
				ok: false,
				code: 'invalid_input',
				state: 'unchanged',
			})
			await expect(rpc.inspectPluginConsumerRequirements(null)).resolves.toMatchObject({
				ok: false,
				code: 'invalid_input',
				state: 'unchanged',
			})
			await expect(rpc.setPluginConsumerOverride(null)).resolves.toMatchObject({
				ok: false,
				code: 'invalid_input',
				state: 'unchanged',
			})
			await expect(rpc.inspectPluginProviderPolicy([])).resolves.toMatchObject({
				ok: false,
				code: 'invalid_input',
				state: 'unchanged',
			})
			await expect(rpc.setPluginProviderPolicyDefault(undefined)).resolves.toMatchObject({
				ok: false,
				code: 'invalid_input',
				state: 'unchanged',
			})
			await expect(rpc.setPluginAutoStart(null)).resolves.toMatchObject({
				ok: false,
				code: 'invalid_input',
				state: 'unchanged',
			})
			await expect(rpc.applyPluginLifecycleCommands(null)).resolves.toMatchObject({
				ok: false,
				code: 'invalid_input',
				state: 'unchanged',
			})
			await expect(rpc.ensurePluginFork('invalid')).resolves.toMatchObject({
				ok: false,
				code: 'invalid_input',
				state: 'unchanged',
			})
			await expect(
				rpc.ensurePluginFork({
					base: pluginNodeAddressOf(ManagedPlugin),
					forkId: 'invalid-selection',
					selectFor: { consumer: null },
				}),
			).resolves.toMatchObject({
				ok: false,
				code: 'invalid_input',
				state: 'unchanged',
			})
			await expect(rpc.removePluginFork(null)).resolves.toMatchObject({
				ok: false,
				code: 'invalid_input',
				state: 'unchanged',
			})
		} finally {
			await host.dispose()
		}
	})

	it('classifies a queued restart after stop as unchanged and unavailable', async () => {
		const host = createRuntimeInternalTestHarness({ workbench: false })
		try {
			host.add(ManagedPlugin)
			await host.commit()
			const address = host.cfg(ManagedPlugin).owner
			await applyLifecycleCommands(host.ctx, [{ address, command: 'start' }])

			const coordinator = requireRuntimePluginGraphCoordinator(host.ctx)
			const stopping = coordinator.stopNode(address, 'test-stop-before-restart')
			const restarting = applyLifecycleCommands(host.ctx, [{ address, command: 'restart' }])
			await stopping

			await expect(restarting).resolves.toMatchObject({
				ok: false,
				status: 'rejected',
				results: [
					{
						address,
						ok: false,
						code: 'restart_unavailable',
						state: 'unchanged',
					},
				],
			})
		} finally {
			await host.dispose()
		}
	})

	it('rejects start for an unavailable node while allowing stop to retain cleanup intent', async () => {
		const host = createRuntimeInternalTestHarness({ workbench: false })
		try {
			host.add(ManagedPlugin)
			host.cfg(ManagedPlugin).setAutoStart(true)
			await host.commit()
			const address = host.cfg(ManagedPlugin).owner
			host.remove(ManagedPlugin)
			await host.commit()
			const rpc = new RuntimeManagementTargetImpl(host.ctx)

			await expect(
				rpc.applyPluginLifecycleCommands([{ address, command: 'start' }]),
			).resolves.toMatchObject({
				ok: false,
				status: 'rejected',
				results: [
					{
						address,
						ok: false,
						code: 'start_unavailable',
						state: 'unchanged',
					},
				],
			})

			await expect(
				rpc.applyPluginLifecycleCommands([{ address, command: 'stop' }]),
			).resolves.toMatchObject({
				ok: true,
				status: 'applied',
				results: [
					{
						address,
						ok: true,
						control: {
							autoStart: true,
							sessionIntent: 'stop',
							desiredState: 'stopped',
							lifecycleState: 'stopped',
						},
					},
				],
			})

			await expect(rpc.setPluginAutoStart([{ address, autoStart: false }])).resolves.toMatchObject({
				ok: true,
				results: [{ ok: true, control: { autoStart: false, desiredState: 'stopped' } }],
			})
			await expect(rpc.setPluginAutoStart([{ address, autoStart: true }])).resolves.toMatchObject({
				ok: false,
				status: 'rejected',
				results: [
					{
						address,
						ok: false,
						code: 'node_unavailable',
						state: 'unchanged',
					},
				],
			})
		} finally {
			await host.dispose()
		}
	})

	it('returns canonical stopped control when stop releases the last unavailable session reference', async () => {
		const host = createRuntimeInternalTestHarness({ workbench: false })
		try {
			host.add(ManagedPlugin)
			await host.commit()
			const address = host.cfg(ManagedPlugin).owner
			const rpc = new RuntimeManagementTargetImpl(host.ctx)
			await rpc.applyPluginLifecycleCommands([{ address, command: 'start' }])

			host.remove(ManagedPlugin)
			await host.commit()

			await expect(
				rpc.applyPluginLifecycleCommands([{ address, command: 'stop' }]),
			).resolves.toMatchObject({
				ok: true,
				status: 'applied',
				results: [
					{
						address,
						ok: true,
						control: {
							autoStart: false,
							sessionIntent: 'inherit',
							desiredState: 'stopped',
							activationReason: null,
							lifecycleState: 'stopped',
						},
					},
				],
			})

			await expect(
				rpc.applyPluginLifecycleCommands([{ address, command: 'stop' }]),
			).resolves.toMatchObject({
				ok: false,
				status: 'rejected',
				results: [{ address, ok: false, code: 'plugin_not_found', state: 'unchanged' }],
			})
		} finally {
			await host.dispose()
		}
	})

	it('does not expose an internal-error catch-all in any control result', () => {
		type ConfigInternal = Extract<ConfigResult, { ok: false; code: 'internal_error' }>
		type PresentationInternal = Extract<
			ConfigPresentationResult,
			{ ok: false; code: 'internal_error' }
		>
		type DependencyInternal = Extract<
			PluginDependencyMutationResult,
			{ ok: false; code: 'internal_error' }
		>
		type ForkInternal = Extract<EnsureForkResult, { ok: false; code: 'internal_error' }>
		type ForkRemoveInternal = Extract<RemoveForkResult, { ok: false; code: 'internal_error' }>
		type StatusInternal = Extract<
			PluginControlMutationResult,
			{ ok: false; code: 'internal_error' }
		>

		expectTypeOf<ConfigInternal>().toEqualTypeOf<never>()
		expectTypeOf<PresentationInternal>().toEqualTypeOf<never>()
		expectTypeOf<DependencyInternal>().toEqualTypeOf<never>()
		expectTypeOf<ForkInternal>().toEqualTypeOf<never>()
		expectTypeOf<ForkRemoveInternal>().toEqualTypeOf<never>()
		expectTypeOf<StatusInternal>().toEqualTypeOf<never>()
	})
})

function expectBrowserSafeReport(report: PluginApplyReport): void {
	expect(() => JSON.stringify(report)).not.toThrow()
	const visit = (value: unknown): void => {
		if (!value || typeof value !== 'object') return
		expect(Object.isFrozen(value)).toBe(true)
		expect(Object.getOwnPropertySymbols(value)).toEqual([])
		for (const child of Object.values(value)) visit(child)
	}
	visit(report)
}
