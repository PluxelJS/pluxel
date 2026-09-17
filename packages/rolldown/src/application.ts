import type { TsdownPlugin, TsdownPluginOption, UserConfig } from 'tsdown'
import {
	createStaticApplicationConfig,
	type StaticApplicationBuildOptions,
} from './cli/static-application'

export type PluxelApplicationBuildOptions = Pick<
	StaticApplicationBuildOptions,
	'variant' | 'launcher' | 'sourceFrameworks' | 'residualDependencies' | 'lint'
>

/** Freeze one declarative application through the standard tsdown configuration and plugin list. */
export function pluxel(options: PluxelApplicationBuildOptions = {}): TsdownPlugin {
	const plugin: TsdownPlugin = {
		name: 'pluxel:application',
		async tsdownConfig(config) {
			if (config.platform !== undefined && config.platform !== 'node')
				throw new TypeError(
					'[pluxel:application] application deployment requires the node platform',
				)
			if (
				config.format !== undefined &&
				config.format !== 'esm' &&
				!(Array.isArray(config.format) && config.format.length === 1 && config.format[0] === 'esm')
			)
				throw new TypeError('[pluxel:application] application deployment requires esm format')
			const preset = createStaticApplicationConfig({
				...options,
				composition: 'host',
				entry: applicationEntry(config.entry),
				cwd: config.cwd,
				outDir: config.outDir,
				minify: config.minify === undefined ? true : Boolean(config.minify),
				sourcemap: Boolean(config.sourcemap),
			})
			return {
				...preset,
				minify: config.minify ?? preset.minify,
				sourcemap: config.sourcemap ?? preset.sourcemap,
				clean: config.clean ?? preset.clean,
				outputOptions: config.outputOptions ?? preset.outputOptions,
				plugins: await replacePlugin(config.plugins ?? [], plugin, preset.plugins ?? []),
			} as UserConfig
		},
	}
	return plugin
}

function applicationEntry(entry: UserConfig['entry']): string {
	if (typeof entry === 'string') return entry
	if (Array.isArray(entry) && entry.length === 1 && typeof entry[0] === 'string') return entry[0]
	if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
		const values = Object.values(entry)
		if (values.length === 1 && typeof values[0] === 'string') return values[0]
	}
	throw new TypeError(
		'[pluxel:application] tsdown entry must select exactly one application module',
	)
}

async function replacePlugin(
	plugins: TsdownPluginOption,
	target: TsdownPlugin,
	replacement: TsdownPluginOption,
): Promise<TsdownPluginOption[]> {
	const resolved = await plugins
	if (resolved === target) return [replacement]
	if (Array.isArray(resolved)) {
		const nested = await Promise.all(
			resolved.map((item) => replacePlugin(item, target, replacement)),
		)
		return nested.flat()
	}
	return [resolved]
}
