import {
	configSourcePlugin,
	lintGuardPlugin,
	runtimeUiBridgePlugin,
	type ConfigSourcePluginOptions,
	type LintGuardPluginOptions,
	type RuntimeUiBridgePluginOptions,
} from '@pluxel/rolldown/plugins'
import { serverOnlyVitePlugin } from '@pluxel/rolldown/vite'
import type { PluginOption } from 'vite'

export type StaticRuntimeVitePluginsOptions = {
	/**
	 * Project root used by lintGuardPlugin. Defaults to process.cwd().
	 */
	root?: string
	configSource?: false | ConfigSourcePluginOptions
	lintGuard?: false | LintGuardPluginOptions
	/**
	 * Build-time lowering for ui(...).bind(ctx). Keep disabled in dev when an HMR host
	 * installs source handles; enable it for packaged/static production builds.
	 */
	runtimeUiBridge?: false | RuntimeUiBridgePluginOptions
}

export function staticRuntimeVitePlugins(
	options: StaticRuntimeVitePluginsOptions = {},
): PluginOption[] {
	const serverPlugins: PluginOption[] = []

	if (options.lintGuard !== false) {
		serverPlugins.push(
			lintGuardPlugin({
				cwd: options.root,
				...(options.lintGuard ?? {}),
			}),
		)
	}
	if (options.configSource !== false) serverPlugins.push(configSourcePlugin(options.configSource ?? {}))

	const plugins: PluginOption[] = []
	if (serverPlugins.length > 0) {
		plugins.push(serverOnlyVitePlugin('pluxel:static-runtime-transform', serverPlugins))
	}
	if (options.runtimeUiBridge !== false) {
		plugins.push(runtimeUiBridgePlugin(options.runtimeUiBridge ?? {}))
	}

	return plugins
}
