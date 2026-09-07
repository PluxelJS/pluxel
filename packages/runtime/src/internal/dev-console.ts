import {
	parsePluginNodeAddress,
	pluginDefinitionIndexKey,
	pluginNodeAddressOf,
	type RootContext,
	type PluginNodeAddress,
	type PluginConstructor,
} from '@pluxel/core'
import { requirePluginService } from '@pluxel/core/internal'
import {
	pluginConfigGet,
	pluginConfigPresentation,
	pluginConfigValidate,
	pluginConfigPatch,
	pluginConfigPatchField,
	pluginConfigReset,
} from '../api/usecases/pluginConfig'
import { pluginStatus, pluginStatusOverview } from '../api/usecases/plugins'
import { applyLifecycleCommands } from '../api/usecases/pluginStatus'
import { requireRuntimeHttpService } from '../context/runtime-http-capability'
import { requireRuntimePluginGraphCoordinator } from './reconciliation'
import { requireRuntimeStateStore } from './runtime-state'
import {
	DevConsoleError,
	type DevConsole,
	type DevPluginTarget,
	type DevTypedPluginTarget,
	type DevPluginInstance,
} from '../dev/contracts'
import { DevScope } from '../dev/scope'
import { createDevLogs } from '../dev/logs'
import { createDevWorkbench } from '../dev/workbench'

export interface DevConsoleScope {
	readonly dev: DevConsole
	abort(): void
	snapshot(): Readonly<{ catalogRevision: number; runtimeStateRevision: number }>
	dispose(): Promise<void>
}

/** Borrow a root for one run. Closing never disposes the root or rolls back application changes. */
export function createDevConsoleScope(
	options: Readonly<{ ctx: RootContext; signal?: AbortSignal }>,
): DevConsoleScope {
	const { ctx } = options
	const scope = new DevScope(options.signal)
	const coordinator = requireRuntimePluginGraphCoordinator(ctx)
	const state = requireRuntimeStateStore(ctx)
	const resolveTarget = (target: DevPluginTarget): PluginNodeAddress => {
		scope.assertOpen()
		let implementation: PluginConstructor | undefined
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
		scope.run(async () => {
			const result = await applyLifecycleCommands(ctx, [
				{ address: resolveTarget(target), command },
			])
			const item = result.results[0]
			if (!item) throw new Error('Production lifecycle command returned no result')
			return item
		})
	const dev: DevConsole = Object.freeze({
		plugins: Object.freeze({
			list: () =>
				scope.run(async () => {
					const overview = await pluginStatusOverview(ctx)
					return overview.plugins
				}),
			status: (target: DevPluginTarget) =>
				scope.run(() => pluginStatus(ctx, resolveTarget(target))),
			start: (target: DevPluginTarget) => lifecycle(target, 'start'),
			stop: (target: DevPluginTarget) => lifecycle(target, 'stop'),
			restart: (target: DevPluginTarget) => lifecycle(target, 'restart'),
			require: <T extends DevTypedPluginTarget>(target: T): DevPluginInstance<T> => {
				if (
					typeof target !== 'function' &&
					(!target || typeof target !== 'object' || !('plugin' in target))
				) {
					throw new TypeError('plugins.require expects a concrete constructor or typed fork target')
				}
				const instance = requirePluginService(ctx).getInstance(resolveTarget(target))
				if (!instance) throw new DevConsoleError('plugin_not_running', 'Plugin node is not running')
				return instance as DevPluginInstance<T>
			},
		}),
		config: Object.freeze({
			get: (target: DevPluginTarget) =>
				scope.run(() => pluginConfigGet(ctx, resolveTarget(target))),
			describe: (target: DevPluginTarget) =>
				scope.run(() => pluginConfigPresentation(ctx, resolveTarget(target))),
			validate: (target: DevPluginTarget, patch: Readonly<Record<string, unknown>>) =>
				scope.run(() => pluginConfigValidate(ctx, resolveTarget(target), patch)),
			patch: (target: DevPluginTarget, patch: Readonly<Record<string, unknown>>) =>
				scope.run(() => pluginConfigPatch(ctx, resolveTarget(target), patch)),
			patchField: (
				target: DevPluginTarget,
				input: Readonly<{ fieldPath: string; value: unknown }>,
			) => scope.run(() => pluginConfigPatchField(ctx, resolveTarget(target), input)),
			reset: (target: DevPluginTarget, keys?: readonly string[]) =>
				scope.run(() =>
					pluginConfigReset(ctx, resolveTarget(target), keys === undefined ? undefined : [...keys]),
				),
		}),
		commands: Object.freeze({
			list: () => {
				scope.assertOpen()
				return ctx.commands.list()
			},
			execute: (
				name: string,
				input: unknown,
				context?: import('@pluxel/commands').CommandContext,
			) =>
				scope.run(() =>
					ctx.commands.execute(name, input, {
						...context,
						signal: context?.signal
							? AbortSignal.any([scope.controller.signal, context.signal])
							: scope.controller.signal,
					}),
				),
		}),
		http: Object.freeze({
			origin: 'http://local.dev',
			fetch: (input: Request | URL | string, init?: RequestInit) =>
				scope.run(async () => {
					const source = new Request(input, init)
					const url = new URL(source.url)
					if (url.protocol !== 'http:' && url.protocol !== 'https:')
						throw new TypeError('Only HTTP(S) requests are supported')
					const request = new Request(source, {
						signal: AbortSignal.any([source.signal, scope.controller.signal]),
					})
					const response = await requireRuntimeHttpService(ctx).fetch(request)
					if (scope.controller.signal.aborted) {
						await response.body?.cancel(scope.controller.signal.reason)
						scope.assertOpen()
					}
					return trackBody(response, scope)
				}),
		}),
		workbench: createDevWorkbench(ctx, scope, resolveTarget),
		logs: createDevLogs(ctx, scope, resolveTarget),
	})
	return Object.freeze({
		dev,
		abort: scope.abort,
		dispose: () => scope.dispose(),
		snapshot: () => ({
			catalogRevision: coordinator.catalogSnapshot().revision,
			runtimeStateRevision: state.versionedSnapshot().revision,
		}),
	})
}

function trackBody(response: Response, scope: DevScope): Response {
	if (!response.body) return response
	const reader = response.body.getReader()
	let finished = false
	const release = scope.own(() => {
		if (finished) return Promise.resolve()
		finished = true
		return reader.cancel(scope.controller.signal.reason)
	})
	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const result = await reader.read()
				if (result.done) {
					finished = true
					release()
					controller.close()
				} else controller.enqueue(result.value)
			} catch (error) {
				finished = true
				release()
				controller.error(error)
			}
		},
		async cancel(reason) {
			try {
				await reader.cancel(reason)
			} finally {
				finished = true
				release()
			}
		},
	})
	const wrapped = new Response(body, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	})
	for (const key of ['url', 'redirected', 'type'] as const)
		Object.defineProperty(wrapped, key, { value: response[key] })
	return wrapped
}
