import { requirePluginHostCoordinator, requireHostStateStore } from '@pluxel/host/internal'
import { createServiceInternalTestHarness } from '@pluxel/services/internal/test'
import { pluginDefinitionAddressOf, pluginNodeAddressOf } from '@pluxel/core'
import { BasePlugin, Plugin } from '@pluxel/core/internal/test'
import { serialize } from 'capnweb'
import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import {
	applyLifecycleCommands,
	setAutoStart,
} from '../../../src/management/api/usecases/pluginStatus.ts'
import { parsePluginStatusQueryResult } from '../../../src/management/web/management-validation.ts'
import { RuntimeManagementTargetImpl } from '../../../src/management/services/management/RuntimeManagementTarget.ts'
import type {
	ConfigResult,
	ConfigPresentationResult,
	EnsureForkResult,
	PluginDependencyMutationResult,
	PluginApplyReport,
	PluginControlMutationResult,
	PluginLifecycleCommand,
	RemoveForkResult,
} from '../../../src/management/web/protocol.ts'

@Plugin()
class ManagedPlugin extends BasePlugin {}

let recoverableFailure = true
@Plugin()
class RecoverablePlugin extends BasePlugin {
	override init() {
		if (recoverableFailure) throw new Error('database initialization failed')
	}
}

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
	it('retains startup diagnostics across unrelated commits and clears them after recovery', async () => {
		await using host = await createServiceInternalTestHarness({ workbench: false })
		recoverableFailure = true
		const logged = vi.spyOn(host.ctx.logger, 'error')

		host.add(RecoverablePlugin)
		host.add(ManagedPlugin)
		await host.commit()
		const address = host.cfg(RecoverablePlugin).owner
		const other = host.cfg(ManagedPlugin).owner
		const rpc = new RuntimeManagementTargetImpl(host.ctx)
		await rpc.applyPluginLifecycleCommandsDto([{ address, command: 'start' }])
		expect(logged).toHaveBeenCalledWith(
			'Plugin lifecycle operation failed',
			expect.objectContaining({
				phase: 'start',
				kind: 'start-failed',
				error: expect.objectContaining({ message: 'database initialization failed' }),
			}),
		)
		const failed = parsePluginStatusQueryResult(await rpc.pluginStatusDto(address))
		expect(failed).toMatchObject({
			ok: true,
			value: {
				lifecycleState: 'stopped',
				issues: [{ code: 'start-failed', message: 'database initialization failed' }],
			},
		})
		await rpc.applyPluginLifecycleCommandsDto([{ address: other, command: 'start' }])
		expect(await rpc.pluginStatusDto(address)).toMatchObject({
			ok: true,
			value: { issues: [{ code: 'start-failed' }] },
		})
		recoverableFailure = false
		await rpc.applyPluginLifecycleCommandsDto([{ address, command: 'start' }])
		expect(await rpc.pluginStatusDto(address)).toMatchObject({
			ok: true,
			value: { lifecycleState: 'running', issues: [] },
		})
	})

	it('exposes only the three process lifecycle commands', () => {
		expectTypeOf<PluginLifecycleCommand>().toEqualTypeOf<'start' | 'stop' | 'restart'>()
	})

	it('keeps expected status and persistence failures closed and state-bearing', async () => {
		await using host = await createServiceInternalTestHarness({ workbench: false })

		host.add(ManagedPlugin)
		await host.commit()
		const address = host.cfg(ManagedPlugin).owner
		const rpc = new RuntimeManagementTargetImpl(host.ctx)

		const startResult = await rpc.applyPluginLifecycleCommandsDto([{ address, command: 'start' }])
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

		const stateStore = requireHostStateStore(host.ctx)
		const commitVersioned = stateStore.commitVersioned.bind(stateStore)
		stateStore.commitVersioned = async () => {
			throw new Error('durable store unavailable')
		}
		const persistenceFailure = await rpc.setPluginAutoStartDto([{ address, autoStart: true }])
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
	})

	it('returns a serializable lifecycle report when an admitted start fails', async () => {
		await using host = await createServiceInternalTestHarness({ workbench: false })

		host.add(FailingManagedPlugin)
		await host.commit()
		const address = host.cfg(FailingManagedPlugin).owner
		const rpc = new RuntimeManagementTargetImpl(host.ctx)

		const result = await rpc.applyPluginLifecycleCommandsDto([{ address, command: 'start' }])
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
	})

	it('keeps provider policy on provider content and consumer override on requirement rows', async () => {
		await using host = await createServiceInternalTestHarness({ workbench: false })

		host.add([ManagedProvider, ManagedAlternateProvider, ManagedProviderConsumer])
		const providerFork = host.fork(ManagedProvider, 'policy-ineligible')
		await host.commit()
		const rpc = new RuntimeManagementTargetImpl(host.ctx)
		const policyOwner = pluginNodeAddressOf(ManagedProvider)
		const alternateProvider = pluginNodeAddressOf(ManagedAlternateProvider)
		const consumer = pluginNodeAddressOf(ManagedProviderConsumer)
		const token = pluginDefinitionAddressOf(ManagedProviderToken)

		await expect(rpc.inspectPluginProviderPolicyDto(consumer)).resolves.toEqual({
			ok: true,
			value: null,
		})
		await expect(rpc.inspectPluginProviderPolicyDto(policyOwner)).resolves.toMatchObject({
			ok: true,
			value: {
				token,
				options: expect.arrayContaining([
					expect.objectContaining({ address: policyOwner }),
					expect.objectContaining({ address: alternateProvider }),
				]),
			},
		})
		const providerPolicy = await rpc.inspectPluginProviderPolicyDto(policyOwner)
		if (!providerPolicy.ok || !providerPolicy.value) {
			throw new Error('expected provider policy')
		}
		expect(
			providerPolicy.value.options.every((option) => option.address.variant === 'default'),
		).toBe(true)
		expect(providerPolicy.value.options).not.toContainEqual(
			expect.objectContaining({ address: providerFork }),
		)
		await expect(rpc.inspectPluginProviderPolicyDto(providerFork)).resolves.toEqual({
			ok: true,
			value: null,
		})
		await expect(
			rpc.setPluginProviderPolicyDefaultDto({
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
			rpc.setPluginProviderPolicyDefaultDto({
				policyOwner: consumer,
				provider: alternateProvider,
			}),
		).resolves.toMatchObject({
			ok: false,
			code: 'provider_policy_unavailable',
			state: 'unchanged',
		})
		const result = await rpc.setPluginProviderPolicyDefaultDto({
			policyOwner,
			provider: alternateProvider,
		})
		expect(result).toMatchObject({ ok: true, status: 'applied', report: {} })
		if (result.ok) expectBrowserSafeReport(result.report)

		await expect(rpc.inspectPluginProviderPolicyDto(policyOwner)).resolves.toMatchObject({
			ok: true,
			value: { defaultProvider: alternateProvider, policyOwnerIsDefault: false },
		})
		await expect(rpc.inspectPluginProviderPolicyDto(alternateProvider)).resolves.toMatchObject({
			ok: true,
			value: { defaultProvider: alternateProvider, policyOwnerIsDefault: true },
		})
		await expect(rpc.inspectPluginConsumerRequirementsDto(consumer)).resolves.toMatchObject({
			ok: true,
			items: [{ requirement: token, consumerOverride: null, inheritedProvider: alternateProvider }],
		})

		await expect(
			rpc.setPluginConsumerOverrideDto({
				consumer,
				requirement: token,
				provider: policyOwner,
			}),
		).resolves.toMatchObject({ ok: true, status: 'applied' })
		await expect(rpc.inspectPluginConsumerRequirementsDto(consumer)).resolves.toMatchObject({
			ok: true,
			items: [
				{
					requirement: token,
					consumerOverride: policyOwner,
					inheritedProvider: alternateProvider,
				},
			],
		})
	})

	it('addresses dependency inspection and mutation by stable requirement identity', async () => {
		await using host = await createServiceInternalTestHarness({ workbench: false })

		host.add([ManagedPlugin, ManagedProvider, ManagedProviderConsumer, ManagedDirectConsumer])
		await host.commit()
		const rpc = new RuntimeManagementTargetImpl(host.ctx)
		const consumer = pluginNodeAddressOf(ManagedProviderConsumer)
		const requirement = pluginDefinitionAddressOf(ManagedProviderToken)

		const inspection = await rpc.inspectPluginConsumerRequirementsDto(consumer)
		expect(inspection).toMatchObject({ ok: true, items: [{ requirement }] })
		if (inspection.ok === false) throw new Error(inspection.error)
		expect(inspection.items[0]).not.toHaveProperty('index')
		expect(inspection.items[0]).not.toHaveProperty('token')
		expect(inspection.items[0]).not.toHaveProperty('effective')
		expect(inspection.items[0]).not.toHaveProperty('isRunning')
		expect(inspection.items[0]).not.toHaveProperty('selected')
		expect(inspection.items[0]).toHaveProperty('consumerOverride', null)

		await expect(
			rpc.inspectPluginConsumerRequirementsDto(pluginNodeAddressOf(ManagedDirectConsumer)),
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
			rpc.setPluginConsumerOverrideDto({ consumer, index: 0, provider: null }),
		).resolves.toMatchObject({ ok: false, code: 'invalid_input', state: 'unchanged' })
		await expect(
			rpc.setPluginConsumerOverrideDto({
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
			rpc.setPluginConsumerOverrideDto({ consumer, requirement, provider: null }),
		).resolves.toMatchObject({ ok: true, status: 'applied', report: {} })
	})

	it('rejects unexpected programming failures instead of classifying their message', async () => {
		await using host = await createServiceInternalTestHarness({ workbench: false })

		host.add(ManagedPlugin)
		await host.commit()
		const address = host.cfg(ManagedPlugin).owner
		const coordinator = requirePluginHostCoordinator(host.ctx)
		const updateRuntimeState = coordinator.updateRuntimeState.bind(coordinator)
		coordinator.updateRuntimeState = (() =>
			Promise.reject(
				new Error('injected programming failure'),
			)) as typeof coordinator.updateRuntimeState

		await expect(setAutoStart(host.ctx, [{ address, autoStart: true }])).rejects.toThrow(
			'injected programming failure',
		)
		coordinator.updateRuntimeState = updateRuntimeState
	})

	it('rejects malformed transport actions before applying any batch item', async () => {
		await using host = await createServiceInternalTestHarness({ workbench: false })

		host.add(ManagedPlugin)
		await host.commit()
		const address = host.cfg(ManagedPlugin).owner
		const rpc = new RuntimeManagementTargetImpl(host.ctx)

		await expect(
			rpc.applyPluginLifecycleCommandsDto([
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
			rpc.applyPluginLifecycleCommandsDto([{ address: { variant: 'default' }, command: 'start' }]),
		).resolves.toMatchObject({
			ok: false,
			status: 'rejected',
			code: 'invalid_input',
			state: 'unchanged',
			results: [],
		})
		await expect(
			rpc.applyPluginLifecycleCommandsDto([{ address, action: 'enable' }]),
		).resolves.toMatchObject({
			ok: false,
			code: 'invalid_input',
			state: 'unchanged',
			results: [],
		})
		await expect(
			rpc.setPluginAutoStartDto([{ address, autoStart: true, enabled: true }]),
		).resolves.toMatchObject({
			ok: false,
			code: 'invalid_input',
			state: 'unchanged',
			results: [],
		})
		await expect(
			rpc.patchPluginConfigFieldDto(address, {
				fieldPath: '__proto__.polluted',
				value: true,
			}),
		).resolves.toMatchObject({
			ok: false,
			code: 'invalid_input',
			state: 'unchanged',
		})
		expect(requirePluginHostCoordinator(host.ctx).catalogSnapshot().byDefinition.size).toBe(1)
	})

	it('returns closed invalid-input results for every Plugin RPC boundary', async () => {
		await using host = await createServiceInternalTestHarness({ workbench: false })

		const rpc = new RuntimeManagementTargetImpl(host.ctx)
		const invalidNode = { variant: 'default' }
		await expect(rpc.pluginConfigPresentationDto(invalidNode)).resolves.toMatchObject({
			ok: false,
			code: 'invalid_input',
		})
		await expect(rpc.pluginConfigDto(invalidNode)).resolves.toMatchObject({
			ok: false,
			code: 'invalid_input',
			state: 'unchanged',
		})
		await expect(rpc.patchPluginConfigDto(invalidNode, null)).resolves.toMatchObject({
			ok: false,
			code: 'invalid_input',
			state: 'unchanged',
		})
		await expect(rpc.patchPluginConfigFieldDto(invalidNode, null)).resolves.toMatchObject({
			ok: false,
			code: 'invalid_input',
			state: 'unchanged',
		})
		await expect(rpc.inspectPluginConsumerRequirementsDto(null)).resolves.toMatchObject({
			ok: false,
			code: 'invalid_input',
			state: 'unchanged',
		})
		await expect(rpc.setPluginConsumerOverrideDto(null)).resolves.toMatchObject({
			ok: false,
			code: 'invalid_input',
			state: 'unchanged',
		})
		await expect(rpc.inspectPluginProviderPolicyDto([])).resolves.toMatchObject({
			ok: false,
			code: 'invalid_input',
			state: 'unchanged',
		})
		await expect(rpc.setPluginProviderPolicyDefaultDto(undefined)).resolves.toMatchObject({
			ok: false,
			code: 'invalid_input',
			state: 'unchanged',
		})
		await expect(rpc.setPluginAutoStartDto(null)).resolves.toMatchObject({
			ok: false,
			code: 'invalid_input',
			state: 'unchanged',
		})
		await expect(rpc.applyPluginLifecycleCommandsDto(null)).resolves.toMatchObject({
			ok: false,
			code: 'invalid_input',
			state: 'unchanged',
		})
		await expect(rpc.ensurePluginForkDto('invalid')).resolves.toMatchObject({
			ok: false,
			code: 'invalid_input',
			state: 'unchanged',
		})
		await expect(
			rpc.ensurePluginForkDto({
				base: pluginNodeAddressOf(ManagedPlugin),
				forkId: 'invalid-selection',
				selectFor: { consumer: null },
			}),
		).resolves.toMatchObject({
			ok: false,
			code: 'invalid_input',
			state: 'unchanged',
		})
		await expect(rpc.removePluginForkDto(null)).resolves.toMatchObject({
			ok: false,
			code: 'invalid_input',
			state: 'unchanged',
		})
	})

	it('classifies a queued restart after stop as unchanged and unavailable', async () => {
		await using host = await createServiceInternalTestHarness({ workbench: false })

		host.add(ManagedPlugin)
		await host.commit()
		const address = host.cfg(ManagedPlugin).owner
		await applyLifecycleCommands(host.ctx, [{ address, command: 'start' }])

		const coordinator = requirePluginHostCoordinator(host.ctx)
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
	})

	it('rejects start for an unavailable node while allowing stop to retain cleanup intent', async () => {
		await using host = await createServiceInternalTestHarness({ workbench: false })

		host.add(ManagedPlugin)
		host.cfg(ManagedPlugin).setAutoStart(true)
		await host.commit()
		const address = host.cfg(ManagedPlugin).owner
		host.remove(ManagedPlugin)
		await host.commit()
		const rpc = new RuntimeManagementTargetImpl(host.ctx)

		await expect(
			rpc.applyPluginLifecycleCommandsDto([{ address, command: 'start' }]),
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
			rpc.applyPluginLifecycleCommandsDto([{ address, command: 'stop' }]),
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

		await expect(rpc.setPluginAutoStartDto([{ address, autoStart: false }])).resolves.toMatchObject(
			{
				ok: true,
				results: [{ ok: true, control: { autoStart: false, desiredState: 'stopped' } }],
			},
		)
		await expect(rpc.setPluginAutoStartDto([{ address, autoStart: true }])).resolves.toMatchObject({
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
	})

	it('returns canonical stopped control when stop releases the last unavailable session reference', async () => {
		await using host = await createServiceInternalTestHarness({ workbench: false })

		host.add(ManagedPlugin)
		await host.commit()
		const address = host.cfg(ManagedPlugin).owner
		const rpc = new RuntimeManagementTargetImpl(host.ctx)
		await rpc.applyPluginLifecycleCommandsDto([{ address, command: 'start' }])

		host.remove(ManagedPlugin)
		await host.commit()

		await expect(
			rpc.applyPluginLifecycleCommandsDto([{ address, command: 'stop' }]),
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
			rpc.applyPluginLifecycleCommandsDto([{ address, command: 'stop' }]),
		).resolves.toMatchObject({
			ok: false,
			status: 'rejected',
			results: [{ address, ok: false, code: 'plugin_not_found', state: 'unchanged' }],
		})
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
