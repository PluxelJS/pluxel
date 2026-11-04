import {
	parsePluginNodeAddress,
	pluginDefinitionIndexKey,
	pluginNodeIndexKey,
	type RootContext,
	type PluginNodeAddress,
	type PluginConstructor,
} from '@pluxel/core'
import { requirePluginService, requireConfigService } from '@pluxel/core/internal'
import {
	projectPluginApplyReport,
	readHostRecentUpdates,
	pluginConfigGet,
	pluginConfigValidate,
	pluginConfigPatch,
	pluginConfigReset,
	readHostConfigState,
	requirePluginHostCoordinator,
	readHostPluginStatusOverview,
	requireHostStateStore,
	createHostPolicy,
	type HostConfigStore,
} from '@pluxel/host/internal'
import {
	DevConsoleError,
	type DevConsole,
	type DevPluginTarget,
	type DevTypedPluginTarget,
	type DevPluginInstance,
} from './contracts'
import { DevScope } from './scope'
import type {
	HostPluginConfigResult,
	PluginApplyReportSnapshot,
	HostConfigMutation,
	HostOperationOptions,
	HostPolicyInput,
	HostPolicyField,
	HostPolicyResult,
} from '@pluxel/host'

export interface DevConsoleScope {
	readonly dev: DevConsole
	abort(): void
	snapshot(): Promise<Readonly<{ catalogRevision: number; runtimeStateRevision: number }>>
	dispose(): Promise<void>
}

/** Borrow a root for one run. Closing never disposes the root or rolls back application changes. */
export function createDevConsoleScope(
	scopeOptions: Readonly<{ ctx: RootContext; id: string; input?: unknown; signal?: AbortSignal }>,
): DevConsoleScope {
	const { ctx } = scopeOptions
	const scope = new DevScope(scopeOptions.signal)
	const admission = { signal: scope.controller.signal }
	const coordinator = requirePluginHostCoordinator(ctx)
	const resolveTarget = (target: DevPluginTarget): PluginNodeAddress => {
		scope.assertOpen()
		let implementation: PluginConstructor
		let address: PluginNodeAddress
		if (typeof target === 'function') {
			implementation = target
			address = target.nodeAddress()
		} else if (target && typeof target === 'object' && 'plugin' in target) {
			implementation = target.plugin
			address = parsePluginNodeAddress({
				definition: implementation.nodeAddress().definition,
				variant: 'fork',
				forkId: target.forkId,
			})
		} else return parsePluginNodeAddress(target)
		const entry = coordinator
			.catalogSnapshot()
			.byDefinition.get(pluginDefinitionIndexKey(address.definition))
		if (!entry)
			throw new DevConsoleError(
				'target_unavailable',
				'Plugin definition is absent from the current catalog',
			)
		if (entry.candidate.implementation !== implementation)
			throw new DevConsoleError(
				'stale_target',
				'Plugin constructor was replaced; import the current implementation',
			)
		return address
	}
	const lifecycle = (target: DevPluginTarget, command: 'start' | 'stop' | 'restart') =>
		scope.run(async () =>
			projectPluginApplyReport(
				ctx,
				await coordinator[`${command}Node`](
					resolveTarget(target),
					`dev-console-${command}`,
					admission,
				),
			),
		)
	const projectConfig = (
		result: HostPluginConfigResult,
	): HostPluginConfigResult<PluginApplyReportSnapshot> => {
		if (result.ok === false) return result
		if (!result.report) return { ...result, report: undefined }
		return { ...result, report: projectPluginApplyReport(ctx, result.report) }
	}
	const policy = createHostPolicy(ctx, requireHostStateStore(ctx))
	const projectPolicy = (result: HostPolicyResult): HostPolicyResult<PluginApplyReportSnapshot> => {
		if (result.ok === false) return result
		return {
			...result,
			report: result.report ? projectPluginApplyReport(ctx, result.report) : undefined,
		}
	}
	const mutationOptions = (options?: HostOperationOptions) => ({
		...options,
		signal: options?.signal
			? AbortSignal.any([scope.controller.signal, options.signal])
			: scope.controller.signal,
	})
	const dev: DevConsole = Object.freeze({
		id: scopeOptions.id,
		input: scopeOptions.input,
		signal: scopeOptions.signal ?? scope.controller.signal,
		updates: Object.freeze({
			latest: () => scope.run(() => readHostRecentUpdates(ctx)?.latestUpdate() ?? null),
		}),
		get ctx() {
			scope.assertOpen()
			return ctx
		},
		plugins: Object.freeze({
			list: () =>
				scope.run(async () => {
					const overview = await readHostPluginStatusOverview(ctx)
					return overview.statuses
				}),
			status: (target: DevPluginTarget) =>
				scope.run(async () => {
					const key = pluginNodeIndexKey(resolveTarget(target))
					const overview = await readHostPluginStatusOverview(ctx)
					return (
						overview.statuses.find((entry) => pluginNodeIndexKey(entry.address) === key) ?? null
					)
				}),
			isRunning: (target: DevPluginTarget) =>
				requirePluginService(ctx).isRunning(resolveTarget(target)),
			start: (target: DevPluginTarget) => lifecycle(target, 'start'),
			stop: (target: DevPluginTarget) => lifecycle(target, 'stop'),
			restart: (target: DevPluginTarget) => lifecycle(target, 'restart'),
			require: <T extends DevTypedPluginTarget>(target: T): DevPluginInstance<T> => {
				if (
					typeof target !== 'function' &&
					(!target || typeof target !== 'object' || !('plugin' in target))
				)
					throw new TypeError('plugins.require expects a concrete constructor or typed fork target')
				const instance = requirePluginService(ctx).getInstance(resolveTarget(target))
				if (!instance) throw new DevConsoleError('plugin_not_running', 'Plugin node is not running')
				return instance as DevPluginInstance<T>
			},
		}),
		policy: Object.freeze({
			get: () => scope.run(async () => projectPolicy(await policy.get())),
			validate: (values: HostPolicyInput) =>
				scope.run(async () => projectPolicy(await policy.validate(values))),
			patch: (values: HostPolicyInput, options?: HostOperationOptions) =>
				scope.run(async () => projectPolicy(await policy.patch(values, mutationOptions(options)))),
			reset: (keys?: readonly HostPolicyField[], options?: HostOperationOptions) =>
				scope.run(async () => projectPolicy(await policy.reset(keys, mutationOptions(options)))),
		}),
		config: Object.freeze({
			inspect: (target: DevPluginTarget) =>
				scope.run(() => {
					const owner = resolveTarget(target)
					return coordinator.readCommitted(() => {
						const store = requireConfigService(ctx) as HostConfigStore
						return {
							mode: store.getMode(owner),
							readonly: store.isReadonly,
							externalReload: store.supportsExternalReload,
							managedInput: store.getManagedInput(owner),
							managedRevision: store.managedRevision,
							shadowedPaths: store.getShadowedPaths(owner),
							declared: store.getDeclaredConfig(owner),
							effectiveInput: store.getRawConfig(owner),
							sources: store.getConfigSources(owner),
						}
					})
				}),
			status: () => {
				scope.assertOpen()
				return readHostConfigState(ctx)
			},
			get: (target: DevPluginTarget) =>
				scope.run(async () =>
					projectConfig(await pluginConfigGet(ctx, resolveTarget(target), admission)),
				),
			validate: (target: DevPluginTarget, patch: HostConfigMutation) =>
				scope.run(async () =>
					projectConfig(await pluginConfigValidate(ctx, resolveTarget(target), patch, admission)),
				),
			patch: (target: DevPluginTarget, patch: HostConfigMutation, options?: HostOperationOptions) =>
				scope.run(async () =>
					projectConfig(
						await pluginConfigPatch(ctx, resolveTarget(target), patch, mutationOptions(options)),
					),
				),
			reset: (
				target: DevPluginTarget,
				paths?: readonly (readonly string[])[],
				options?: HostOperationOptions,
			) =>
				scope.run(async () =>
					projectConfig(
						await pluginConfigReset(ctx, resolveTarget(target), paths, mutationOptions(options)),
					),
				),
		}),
	})
	return Object.freeze({
		dev,
		abort: scope.abort,
		dispose: () => scope.dispose(),
		snapshot: () =>
			coordinator.readCommitted((view) => ({
				catalogRevision: view.catalog.revision,
				runtimeStateRevision: view.runtimeState.revision,
			})),
	})
}
