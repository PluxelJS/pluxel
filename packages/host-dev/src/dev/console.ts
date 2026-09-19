import {
	parsePluginNodeAddress,
	pluginDefinitionIndexKey,
	pluginNodeAddressOf,
	pluginNodeIndexKey,
	type RootContext,
	type PluginNodeAddress,
	type PluginConstructor,
} from '@pluxel/core'
import { requirePluginService } from '@pluxel/core/internal'
import {
	projectPluginApplyReport,
	readHostRecentUpdates,
	pluginConfigGet,
	pluginConfigValidate,
	pluginConfigPatch,
	pluginConfigReset,
	requirePluginHostCoordinator,
	readHostPluginStatusOverview,
} from '@pluxel/host/internal'
import {
	DevConsoleError,
	type DevConsole,
	type DevPluginTarget,
	type DevTypedPluginTarget,
	type DevPluginInstance,
} from './contracts'
import { DevScope } from './scope'
import type { HostPluginConfigResult, PluginApplyReportSnapshot } from '@pluxel/host'

export interface DevConsoleScope {
	readonly dev: DevConsole
	abort(): void
	snapshot(): Promise<Readonly<{ catalogRevision: number; runtimeStateRevision: number }>>
	dispose(): Promise<void>
}

/** Borrow a root for one run. Closing never disposes the root or rolls back application changes. */
export function createDevConsoleScope(
	options: Readonly<{ ctx: RootContext; id: string; input?: unknown; signal?: AbortSignal }>,
): DevConsoleScope {
	const { ctx } = options
	const scope = new DevScope(options.signal)
	const admission = { signal: scope.controller.signal }
	const coordinator = requirePluginHostCoordinator(ctx)
	const resolveTarget = (target: DevPluginTarget): PluginNodeAddress => {
		scope.assertOpen()
		let implementation: PluginConstructor
		let address: PluginNodeAddress
		if (typeof target === 'function') {
			implementation = target
			address = pluginNodeAddressOf(target)
		} else if (target && typeof target === 'object' && 'plugin' in target) {
			implementation = target.plugin
			address = parsePluginNodeAddress({
				definition: pluginNodeAddressOf(implementation).definition,
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
		if (result.ok === false || result.saved === false) return result
		return { ...result, report: projectPluginApplyReport(ctx, result.report) }
	}
	const dev: DevConsole = Object.freeze({
		id: options.id,
		input: options.input,
		signal: options.signal ?? scope.controller.signal,
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
		config: Object.freeze({
			get: (target: DevPluginTarget) =>
				scope.run(async () =>
					projectConfig(await pluginConfigGet(ctx, resolveTarget(target), admission)),
				),
			validate: (target: DevPluginTarget, patch: Readonly<Record<string, unknown>>) =>
				scope.run(async () =>
					projectConfig(await pluginConfigValidate(ctx, resolveTarget(target), patch, admission)),
				),
			patch: (target: DevPluginTarget, patch: Readonly<Record<string, unknown>>) =>
				scope.run(async () =>
					projectConfig(await pluginConfigPatch(ctx, resolveTarget(target), patch, admission)),
				),
			reset: (target: DevPluginTarget, keys?: readonly string[]) =>
				scope.run(async () =>
					projectConfig(await pluginConfigReset(ctx, resolveTarget(target), keys, admission)),
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
