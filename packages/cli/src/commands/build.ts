import { type ArgValues, define } from 'gunshi'
import { buildCommandArgs, buildCommandDefinition } from '../command-manifest'

type BuildRuntimeConfig = import('@pluxel/rolldown/build').BuildRuntimeConfig

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
			extraConfig: (context: BuildRuntimeConfig) =>
				build.pluginPackage({
					root: context.projectRoot,
					additionalPlugins: [importTracker.plugin],
				}),
		})
	},
})
