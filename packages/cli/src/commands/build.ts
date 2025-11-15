import { define, type ArgValues } from 'gunshi'
import { resolveBuildContext } from '../build/config'
import { createOptionalDependencyHook } from '../build/plugin-tracker'
import { runWithTsdown } from '../build/tsdown-runner'
import { createImportTracker } from '../build/plugins/import-tracker'

const buildCommandArgs = {
	root: {
		type: 'string',
		description: 'Project root that contains tsdown config',
		default: '.',
	},
	watch: {
		type: 'boolean',
		description: 'Enable watch mode',
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

		// 使用 Rolldown 插件在 bundler 内部跟踪 import，效率比提前用 parse-imports 扫目录更高
		const importTracker = createImportTracker(runtime.pluginPrefixes)
		const pluginHook = createOptionalDependencyHook({
			packageJsonPath: runtime.packageJsonPath,
			log: ctx.log,
			collectPlugins: () => importTracker.flush(),
		})

		await runWithTsdown({
			context: runtime,
			onSuccess: pluginHook,
			log: ctx.log,
			extraConfig: {
				plugins: [importTracker.plugin],
			},
		})
	},
})
