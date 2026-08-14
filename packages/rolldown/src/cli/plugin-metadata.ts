import type { PluginDependencyMode } from '../rolldown/plugins/pluginSemanticsPlugin'
import type { ResolvedConfig } from 'tsdown'
import { runRules } from './rules'
import type { BuildLogger, BuildRuntimeConfig, BuildSuccessHook } from './types'

export interface PluginDependencyMetadataOptions extends Pick<
	BuildRuntimeConfig,
	'packageJsonPath' | 'manifestField'
> {
	log: BuildLogger
	collectPlugins: () => Map<string, PluginDependencyMode>
}

export function createPluginDependencyMetadataHook(
	options: PluginDependencyMetadataOptions,
): BuildSuccessHook {
	return async (_config: ResolvedConfig, signal: AbortSignal) => {
		const plugins = options.collectPlugins()
		if (signal.aborted) return
		const updates = await runRules({
			packageJsonPath: options.packageJsonPath,
			manifestField: options.manifestField,
			pluginUsages: plugins,
		})
		for (const message of updates ?? []) options.log(`[build] ${message}`)
	}
}
