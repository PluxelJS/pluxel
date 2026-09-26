import { type ArgValues, define } from 'gunshi'
import { loadOfficialCapability } from '../capability-loader'
import { buildCommandArgs, buildCommandDefinition } from '../command-manifest'

type BuildCommandArgs = typeof buildCommandArgs
type BuildCommandValues = ArgValues<BuildCommandArgs>

export const buildCommand = define({
	...buildCommandDefinition,
	async run(ctx) {
		const build = await loadOfficialCapability('rolldown-build')
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
			extraConfig: (context) =>
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
