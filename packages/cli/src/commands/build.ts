import { configSourcePlugin, createImportTracker, importTypeFixerPlugin } from '@pluxel/rolldown'
import { type ArgValues, define } from 'gunshi'
import type { InlineConfig } from 'tsdown'
import { resolveBuildContext } from '../build_impl/config'
import { createOptionalDependencyHook } from '../build_impl/plugin-tracker'
import { cliTsdownOverlay } from '../build_impl/tsdown-config'
import { runWithTsdown } from '../build_impl/tsdown-runner'
import type { BuildRuntimeConfig } from '../build_impl/types'

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
		const importTracker = createImportTracker({ prefixes: runtime.pluginPrefixes })
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
			extraConfig: mergeOverlayPlugins(cliTsdownOverlay, [
				importTypeFixerPlugin(),
				configSourcePlugin(),
				importTracker.plugin,
			]),
		})
	},
})

function mergeOverlayPlugins(
	overlay: typeof cliTsdownOverlay,
	additional: InlineConfig['plugins'],
) {
	return async (ctx: BuildRuntimeConfig): Promise<InlineConfig> => {
		const awaited = typeof overlay === 'function' ? await overlay(ctx) : overlay
		// defineConfig 可能返回数组，取第一个
		const resolved = Array.isArray(awaited) ? awaited[0] : awaited
		if (!resolved) return { plugins: additional }
		const overlayPlugins = resolved.plugins
		const additionalArr = Array.isArray(additional) ? additional : additional ? [additional] : []
		const plugins = overlayPlugins
			? Array.isArray(overlayPlugins)
				? [...overlayPlugins, ...additionalArr]
				: [overlayPlugins, ...additionalArr]
			: additional
		return { ...resolved, plugins }
	}
}
