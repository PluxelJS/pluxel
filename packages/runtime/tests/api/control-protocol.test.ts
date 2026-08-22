import { requireRuntimePluginGraphCoordinator, runtimeStatePatch } from '@pluxel/runtime/internal'
import { pluginDefinitionAddressOf, pluginNodeAddressOf } from '@pluxel/core'
import { BasePlugin, createRuntimeHost, Plugin } from '@pluxel/runtime/test'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { applyStatusActions } from '../../src/api/usecases/pluginStatus'
import { RuntimeRpcApi } from '../../src/api/http/rpc/RuntimeRpcApi'
import type {
	ConfigResult,
	EnsureForkResult,
	PluginDependencyMutationResult,
	PluginApplyReport,
	PluginStatusAction,
	PluginStatusMutationResult,
	RemoveForkResult,
	SchemaResult,
} from '../../src/web/protocol'
import { requireRuntimeStateStore } from '../../src/internal/runtime-state'

@Plugin()
class ManagedPlugin extends BasePlugin {}

abstract class ManagedProviderToken extends BasePlugin {}

@Plugin(ManagedProviderToken)
class ManagedProvider extends ManagedProviderToken {}

@Plugin()
class ManagedProviderConsumer extends BasePlugin {
	constructor(readonly provider: ManagedProviderToken) {
		super()
	}
}

describe('runtime web control protocol', () => {
	it('exposes only the three durable lifecycle actions', () => {
		expectTypeOf<PluginStatusAction>().toEqualTypeOf<'enable' | 'disable' | 'restart'>()
	})

	it('keeps expected status and persistence failures closed and state-bearing', async () => {
		const host = createRuntimeHost({ workbench: false })
		try {
			host.add(ManagedPlugin)
			await host.commit()
			const address = host.cfg(ManagedPlugin).owner
			const rpc = new RuntimeRpcApi(host.ctx)

			await expect(
				rpc.applyPluginStatusActions([{ address, action: 'enable' }]),
			).resolves.toMatchObject({
				ok: true,
				status: 'applied',
				results: [
					{
						address,
						ok: true,
						status: 'applied',
						report: { core: { status: 'committed' } },
						isRunning: true,
						isEnabled: true,
						lifecycleStage: 'running',
					},
				],
			})

			const stateStore = requireRuntimeStateStore(host.ctx)
			const commitVersioned = stateStore.commitVersioned.bind(stateStore)
			stateStore.commitVersioned = async () => {
				throw new Error('durable store unavailable')
			}
			await expect(
				rpc.applyPluginStatusActions([{ address, action: 'disable' }]),
			).resolves.toMatchObject({
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
			stateStore.commitVersioned = commitVersioned
		} finally {
			await host.dispose()
		}
	})

	it('preserves the browser-safe report on provider-default mutation RPC', async () => {
		const host = createRuntimeHost({ workbench: false })
		try {
			host.add([ManagedProvider, ManagedProviderConsumer])
			await host.commit()
			const rpc = new RuntimeRpcApi(host.ctx)
			const result = await rpc.selectPluginBaseProvider({
				consumer: pluginNodeAddressOf(ManagedProviderConsumer),
				token: pluginDefinitionAddressOf(ManagedProviderToken),
				provider: pluginNodeAddressOf(ManagedProvider),
			})
			expect(result).toMatchObject({ ok: true, status: 'applied', report: {} })
			if (result.ok) expectBrowserSafeReport(result.report)
		} finally {
			await host.dispose()
		}
	})

	it('rejects unexpected programming failures instead of classifying their message', async () => {
		const host = createRuntimeHost({ workbench: false })
		try {
			host.add(ManagedPlugin)
			await host.commit()
			const address = host.cfg(ManagedPlugin).owner
			const coordinator = requireRuntimePluginGraphCoordinator(host.ctx)
			const runExclusive = coordinator.runExclusive.bind(coordinator)
			coordinator.runExclusive = (() =>
				Promise.reject(
					new Error('injected programming failure'),
				)) as typeof coordinator.runExclusive

			await expect(applyStatusActions(host.ctx, [{ address, action: 'enable' }])).rejects.toThrow(
				'injected programming failure',
			)
			coordinator.runExclusive = runExclusive
		} finally {
			await host.dispose()
		}
	})

	it('rejects malformed transport actions before applying any batch item', async () => {
		const host = createRuntimeHost({ workbench: false })
		try {
			host.add(ManagedPlugin)
			await host.commit()
			const address = host.cfg(ManagedPlugin).owner
			const rpc = new RuntimeRpcApi(host.ctx)

			await expect(
				rpc.applyPluginStatusActions([
					{ address, action: 'enable' },
					{ address, action: 'stop' },
				]),
			).resolves.toEqual({
				ok: false,
				status: 'rejected',
				code: 'invalid_input',
				state: 'unchanged',
				error: 'Plugin status action at index 1 is invalid',
				results: [],
			})
			await expect(
				rpc.applyPluginStatusActions([{ address: { variant: 'default' }, action: 'enable' }]),
			).resolves.toMatchObject({
				ok: false,
				status: 'rejected',
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
		const host = createRuntimeHost({ workbench: false })
		try {
			const rpc = new RuntimeRpcApi(host.ctx)
			const invalidNode = { variant: 'default' }
			await expect(rpc.pluginSchema(invalidNode)).resolves.toMatchObject({
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
			await expect(rpc.pluginDependencies(invalidNode)).resolves.toMatchObject({
				ok: false,
				code: 'invalid_input',
				state: 'unchanged',
			})
			await expect(rpc.inspectPluginDependencies(null)).resolves.toMatchObject({
				ok: false,
				code: 'invalid_input',
				state: 'unchanged',
			})
			await expect(rpc.setPluginDependencyTarget(null)).resolves.toMatchObject({
				ok: false,
				code: 'invalid_input',
				state: 'unchanged',
			})
			await expect(rpc.inspectPluginBaseProvider([])).resolves.toMatchObject({
				ok: false,
				code: 'invalid_input',
				state: 'unchanged',
			})
			await expect(rpc.selectPluginBaseProvider(undefined)).resolves.toMatchObject({
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

	it('classifies a queued restart after disable as unchanged and unavailable', async () => {
		const host = createRuntimeHost({ workbench: false })
		try {
			host.add(ManagedPlugin)
			await host.commit()
			const address = host.cfg(ManagedPlugin).owner
			await applyStatusActions(host.ctx, [{ address, action: 'enable' }])

			const coordinator = requireRuntimePluginGraphCoordinator(host.ctx)
			const disabling = coordinator.updateRuntimeState(
				runtimeStatePatch({ type: 'set-enabled', node: address, enabled: false }),
				'test-disable-before-restart',
			)
			const restarting = applyStatusActions(host.ctx, [{ address, action: 'restart' }])
			await disabling

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

	it('does not expose an internal-error catch-all in any control result', () => {
		type ConfigInternal = Extract<ConfigResult, { ok: false; code: 'internal_error' }>
		type SchemaInternal = Extract<SchemaResult, { ok: false; code: 'internal_error' }>
		type DependencyInternal = Extract<
			PluginDependencyMutationResult,
			{ ok: false; code: 'internal_error' }
		>
		type ForkInternal = Extract<EnsureForkResult, { ok: false; code: 'internal_error' }>
		type ForkRemoveInternal = Extract<RemoveForkResult, { ok: false; code: 'internal_error' }>
		type StatusInternal = Extract<PluginStatusMutationResult, { ok: false; code: 'internal_error' }>

		expectTypeOf<ConfigInternal>().toEqualTypeOf<never>()
		expectTypeOf<SchemaInternal>().toEqualTypeOf<never>()
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
