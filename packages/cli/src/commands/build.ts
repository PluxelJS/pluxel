import { type ArgValues, define } from 'gunshi'
import type { InlineConfig } from 'tsdown'
import { buildCommandArgs, buildCommandDefinition } from '../command-manifest'

type BuildRuntimeConfig = import('@pluxel/rolldown/build').BuildRuntimeConfig
type CliTsdownOverlay = (typeof import('@pluxel/rolldown/build'))['cliTsdownOverlay']

type BuildCommandArgs = typeof buildCommandArgs
type BuildCommandValues = ArgValues<BuildCommandArgs>

export const buildCommand = define({
	...buildCommandDefinition,
	async run(ctx) {
		const [build, plugins] = await Promise.all([
			import('@pluxel/rolldown/build'),
			import('@pluxel/rolldown/plugins'),
		])
		// 先读取 workspace 配置，这里只负责 build 命令，不做 scaffold 以外的逻辑
		const runtime = await build.resolveBuildContext(ctx.values as BuildCommandValues)

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
		const importTracker = plugins.createImportTracker({ prefixes: runtime.pluginPrefixes })
		const pluginHook = build.createOptionalDependencyHook({
			packageJsonPath: runtime.packageJsonPath,
			manifestField: runtime.manifestField,
			log: ctx.log,
			collectPlugins: () => importTracker.flush(),
		})

		await build.runWithTsdown({
			context: runtime,
			onSuccess: pluginHook,
			log: ctx.log,
			extraConfig: mergeOverlayPlugins(build.cliTsdownOverlay, [importTracker.plugin]),
		})
	},
})

function mergeOverlayPlugins(overlay: CliTsdownOverlay, additional: InlineConfig['plugins']) {
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
