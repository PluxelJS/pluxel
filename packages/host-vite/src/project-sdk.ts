import type { PluginConstructor, RootContext } from '@pluxel/core'
import type { PluginTarget, ScriptScope } from '@pluxel/host/agent'
import type { ProjectSdk } from './project'

/** The extension borrows the same run scope and Host as the portable SDK. */
export function createProjectSdk(ctx: RootContext, scope: ScriptScope): ProjectSdk {
	const plugin = ((target: PluginTarget | PluginConstructor) =>
		typeof target === 'function'
			? scope.selectPlugin(target.nodeAddress(), target)
			: scope.sdk.plugin(target)) as ProjectSdk['plugin']
	return Object.freeze({
		...scope.sdk,
		plugin,
		dev: Object.freeze({
			get ctx() {
				scope.assertOpen()
				return ctx
			},
		}),
	})
}
