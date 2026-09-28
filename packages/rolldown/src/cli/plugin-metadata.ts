import type { PluginDependencyMode } from '../rolldown/plugins/pluginSemanticsPlugin'
import type { ResolvedConfig } from 'tsdown'
import { runRules } from './rules'
import { validateWorkbenchCapnwebPeer } from './workbench-peer'
import type { BuildLogger, BuildRuntimeConfig, BuildSuccessHook } from './types'

export interface PluginDependencyMetadataOptions extends Pick<
	BuildRuntimeConfig,
	'packageJsonPath' | 'manifestField'
> {
	log: BuildLogger
	collectPlugins: () => Map<string, PluginDependencyMode>
	collectWorkbenchTargets: () => Promise<boolean>
}

export function createPluginDependencyMetadataHook(
	options: PluginDependencyMetadataOptions,
): BuildSuccessHook {
	return async (_config: ResolvedConfig, signal: AbortSignal) => {
		const plugins = options.collectPlugins()
		if (signal.aborted) return
		let version: string | undefined
		if (await options.collectWorkbenchTargets()) {
			version = await validateWorkbenchCapnwebPeer(options.packageJsonPath)
			options.log(`[build] Workbench capnweb target boundary verified at ${version}`)
		}
		if (signal.aborted) return
		const updates = await runRules({
			packageJsonPath: options.packageJsonPath,
			manifestField: options.manifestField,
			pluginUsages: plugins,
			workbenchCapnwebVersion: version,
		})
		for (const message of updates ?? []) options.log(`[build] ${message}`)
	}
}
