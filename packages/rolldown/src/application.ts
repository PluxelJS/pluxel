import { createModulesApplicationConfig } from './cli/modules-application'
import type { TsdownPlugin, TsdownPluginOption, UserConfig } from 'tsdown'
import {
	createStaticApplicationConfig,
	resolveResidualDependencies,
	type StaticApplicationBuildOptions,
} from './cli/static-application'

export type PluxelApplicationBuildOptions =
	| (Pick<StaticApplicationBuildOptions, 'variant' | 'launcher' | 'residualDependencies' | 'lint'> &
			Readonly<{ delivery?: 'standalone' }>)
	| Readonly<{
			delivery: 'modules'
			variant?: 'headless' | 'workbench'
			lint?: boolean
			launcher?: never
			residualDependencies?: never
	  }>

/** Build one declarative application with standalone or modules delivery. */
export function pluxel(options: PluxelApplicationBuildOptions = {}): TsdownPlugin {
	if (
		options.delivery !== undefined &&
		options.delivery !== 'standalone' &&
		options.delivery !== 'modules'
	)
		throw new TypeError('[pluxel:application] delivery must be standalone or modules')
	for (const key of Object.keys(options))
		if (!['delivery', 'variant', 'launcher', 'residualDependencies', 'lint'].includes(key))
			throw new TypeError(`[pluxel:application] unsupported ${key}`)
	if (
		options.variant !== undefined &&
		options.variant !== 'headless' &&
		options.variant !== 'workbench'
	)
		throw new TypeError('[pluxel:application] variant must be headless or workbench')
	if (options.lint !== undefined && typeof options.lint !== 'boolean')
		throw new TypeError('[pluxel:application] lint must be a boolean')
	if (options.delivery === 'modules')
		for (const key of ['launcher', 'residualDependencies'])
			if (Object.hasOwn(options, key))
				throw new TypeError(`[pluxel:application] modules includes standalone-only ${key}`)
	options =
		options.delivery === 'modules'
			? Object.freeze({ ...options })
			: Object.freeze({
					...options,
					...(options.residualDependencies === undefined
						? {}
						: {
								residualDependencies: Object.freeze(
									resolveResidualDependencies(options.residualDependencies),
								),
							}),
				})
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
			const preset =
				options.delivery === 'modules'
					? await createModulesApplicationConfig({
							...options,
							entry: applicationEntry(config.entry),
							cwd: config.cwd,
							outDir: config.outDir,
							minify: config.minify === undefined ? true : Boolean(config.minify),
							sourcemap: Boolean(config.sourcemap),
						})
					: createStaticApplicationConfig({
							...options,
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
