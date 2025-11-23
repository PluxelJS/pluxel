import { type ArgValues, define } from 'gunshi'
import type { Plugin } from 'rolldown'
import { resolveBuildContext } from '../tsbuild/config'
import { createOptionalDependencyHook } from '../tsbuild/plugin-tracker'
import { createImportTracker } from '../tsbuild/plugins/import-tracker'
import { cliTsdownOverlay } from '../tsbuild/tsdown-config'
import { runWithTsdown } from '../tsbuild/tsdown-runner'
import type { BuildRuntimeConfig } from '../tsbuild/types'

const buildCommandArgs = {
	watch: {
		type: 'boolean',
		description: 'Enable watch mode',
		default: false,
	},
	debug: {
		type: 'boolean',
		description: 'Print resolved tsdown config before running',
		default: false,
	},
} as const

type BuildCommandArgs = typeof buildCommandArgs
type BuildCommandValues = ArgValues<BuildCommandArgs>

export const buildCommand = define({
	name: 'build',
	description: 'Build current project',
	args: buildCommandArgs,
	async run(ctx) {
		// 先读取 workspace 配置，这里只负责 build 命令，不做 scaffold 以外的逻辑
		const runtime = await resolveBuildContext(ctx.values as BuildCommandValues)

		ctx.log(`[build] root: ${runtime.projectRoot}`)
		ctx.log(`[build] package.json: ${runtime.packageJsonPath}`)
		if (runtime.pluginPrefixes.length > 0) {
			ctx.log(`[build] plugin prefixes: ${runtime.pluginPrefixes.join(', ')}`)
		}
		if (runtime.tsdownConfigPath) {
			ctx.log(`[build] tsdown overrides: ${runtime.tsdownConfigPath}`)
		}
		if (runtime.debug) {
			ctx.log('[build] debug mode enabled')
		}

		// 使用 Rolldown 插件在 bundler 内部跟踪 import，效率比提前用 parse-imports 扫目录更高
		const importTracker = createImportTracker(runtime.pluginPrefixes)
		const pluginHook = createOptionalDependencyHook({
			packageJsonPath: runtime.packageJsonPath,
			manifestField: runtime.manifestField,
			log: ctx.log,
			collectPlugins: () => importTracker.flush(),
		})

		await runWithTsdown({
			context: runtime,
			onSuccess: pluginHook,
			log: ctx.log,
			extraConfig: mergeOverlayPlugins(cliTsdownOverlay, importTracker.plugin),
		})
	},
})

function mergeOverlayPlugins(overlay: typeof cliTsdownOverlay, additional: Plugin) {
	return (ctx: BuildRuntimeConfig) => {
		const resolved = typeof overlay === 'function' ? overlay(ctx) : overlay
		const overlayPlugins = resolved.plugins
		const plugins = overlayPlugins
			? Array.isArray(overlayPlugins)
				? [...overlayPlugins, additional]
				: [overlayPlugins, additional]
			: [additional]
		return { ...resolved, plugins }
	}
}
