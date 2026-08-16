import { type ArgValues, define } from 'gunshi'
import { buildCommandArgs, buildCommandDefinition } from '../command-manifest'

type BuildRuntimeConfig = import('@pluxel/rolldown/build').BuildRuntimeConfig

type BuildCommandArgs = typeof buildCommandArgs
type BuildCommandValues = ArgValues<BuildCommandArgs>

export const buildCommand = define({
	...buildCommandDefinition,
	async run(ctx) {
		const build = await import('@pluxel/rolldown/build')
		// 先读取 workspace 配置，这里只负责 build 命令，不做 scaffold 以外的逻辑
		const runtime = await build.resolveBuildContext(ctx.values as BuildCommandValues)

		ctx.log(`[build] root: ${runtime.projectRoot}`)
		ctx.log(`[build] package.json: ${runtime.packageJsonPath}`)
		if (runtime.tsdownConfigPath) {
			ctx.log(`[build] tsdown overrides: ${runtime.tsdownConfigPath}`)
		}
		if (runtime.debug) {
			ctx.log('[build] debug mode enabled')
		}

		// pluginPackage preset owns source semantics and derived package metadata.
		await build.runWithTsdown({
			context: runtime,
			log: ctx.log,
			extraConfig: (context: BuildRuntimeConfig) =>
				build.pluginPackage({
					root: context.projectRoot,
					packageMetadata: {
						packageJsonPath: context.packageJsonPath,
						manifestField: context.manifestField,
						log: ctx.log,
					},
				}),
		})
	},
})
