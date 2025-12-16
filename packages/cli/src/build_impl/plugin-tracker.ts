import type { TrackedPluginUsage } from '@pluxel/rolldown'
import type { ResolvedConfig } from 'tsdown'
import { runRules } from './rules'
import type { BuildLogger, BuildRuntimeConfig, BuildSuccessHook } from './types'

export interface PluginTrackerOptions
	extends Pick<BuildRuntimeConfig, 'packageJsonPath' | 'manifestField'> {
	log: BuildLogger
	collectPlugins: () => Map<string, TrackedPluginUsage>
}

export function createOptionalDependencyHook(options: PluginTrackerOptions): BuildSuccessHook {
	let lastSignature: string | undefined

	return async (_config: ResolvedConfig, signal: AbortSignal) => {
		try {
			// 通过 rolldown 插件收集的 import 列表来同步项目元信息
			const plugins = options.collectPlugins()
			if (signal.aborted) return

			const signature = serializePluginSet(plugins)
			if (signature === lastSignature) return

			const updates = await runRules({
				packageJsonPath: options.packageJsonPath,
				manifestField: options.manifestField,
				pluginUsages: plugins,
			})
			if (updates?.length) {
				for (const message of updates) {
					options.log(`[build] ${message}`)
				}
			}

			lastSignature = signature
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error)
			options.log(`[build] warn: plugin metadata sync failed: ${reason}`)
		}
	}
}

function serializePluginSet(plugins: Map<string, TrackedPluginUsage>) {
	return JSON.stringify(
		Array.from(plugins.entries())
			.map(([name, usage]) => [name, usage.hasStaticImport, usage.hasDynamicImport] as const)
			.sort(([nameA], [nameB]) => nameA.localeCompare(nameB)),
	)
}
