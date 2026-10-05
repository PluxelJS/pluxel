import { recordLoadedApplicationPlugins } from './loaded-modules'
import { isAbsolute, resolve } from 'node:path'
import { mergeConfigRecords } from './config-records'
import { resolveInputBindings } from './input-bindings'
import { createNativeSourceLoader } from './native-source-loader'
import { discoverPluginSources } from './source-discovery'
import { installPluginSources, pluginSource } from './source-contract'
import { setHostCatalogProvenance } from './catalog-provenance'
import type { PluginCatalogProvenance } from './catalog'
import type { PluginConstructor } from '@pluxel/core'
import type { HostService } from './services'
import { createHost, type HostApplication, type HostRuntimeOptions, type PluginHost } from './host'

export type HostStartupContext<
	TBindings extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>,
> = Readonly<{
	root: string
	mode: 'development' | 'production' | 'test'
	env: Readonly<Record<string, string | undefined>>
	bindings: TBindings
	deployment?: Readonly<{ root: string; target: 'node'; variant: 'headless' | 'workbench' }>
}>
/** Complete application configuration evaluated once for each fresh Host. */
export type HostApplicationFactory = (
	startup: HostStartupContext,
) => HostApplication | Promise<HostApplication>

type UnsupportedApplicationFields<T> = T extends unknown
	? Exclude<keyof T, keyof HostApplication>
	: never

/** Declare a deferred application factory, preserving its inferred result type. */
export function defineHostApplication<const T extends HostApplicationFactory>(
	factory: T &
		(UnsupportedApplicationFields<Awaited<ReturnType<T>>> extends never ? unknown : never),
): T {
	if (typeof factory !== 'function') throw new TypeError('[host] Application must be a factory')
	return factory
}

export type ResolvedHostApplication = HostRuntimeOptions &
	Readonly<{
		/** Immutable shallow snapshot shared by the factory and prepare callback. */
		startup: HostStartupContext
		name?: string
		plugins: readonly PluginConstructor[]
		sources?: HostApplication['sources']
		prepare?: HostApplication['prepare']
	}>
const fields = new Set([
	'name',
	'plugins',
	'sources',
	'services',
	'config',
	'state',
	'configRecords',
	'envBindings',
	'fileBindings',
	'prepare',
])
function record(input: unknown, label: string): Record<string, unknown> {
	if (!input || typeof input !== 'object' || Array.isArray(input))
		throw new TypeError(`${label} must be an object`)
	return input as Record<string, unknown>
}
function assertFields(input: Record<string, unknown>, allowed: Set<string>, label: string): void {
	for (const key of Object.keys(input))
		if (!allowed.has(key)) throw new TypeError(`${label} includes unsupported "${key}"`)
}
export function assertHostApplication(input: unknown): asserts input is HostApplication {
	const app = record(input, '[host] Application')
	assertFields(app, fields, '[host] Application')
	if (!Array.isArray(app.plugins))
		throw new TypeError('[host] Application plugins must be an array')
	if (app.sources !== undefined) {
		if (!Array.isArray(app.sources))
			throw new TypeError('[host] Application sources must be an array')
		app.sources.forEach(pluginSource)
	}
	if (app.services !== undefined && !Array.isArray(app.services))
		throw new TypeError('[host] Application services must be an array')
	for (const key of ['envBindings', 'fileBindings'])
		if (app[key] !== undefined && !Array.isArray(app[key]))
			throw new TypeError(`[host] Application ${key} must be an array`)
	if (app.prepare !== undefined && typeof app.prepare !== 'function')
		throw new TypeError('[host] Application prepare must be a function')
}
function snapshotStartup(input: HostStartupContext): HostStartupContext {
	const startup = record(input, '[host] startup')
	assertFields(
		startup,
		new Set(['root', 'mode', 'env', 'bindings', 'deployment']),
		'[host] startup',
	)
	if (typeof startup.root !== 'string' || !isAbsolute(startup.root))
		throw new TypeError('[host] startup.root must be absolute')
	if (!['development', 'production', 'test'].includes(startup.mode as string))
		throw new TypeError('[host] startup.mode must be development, production or test')
	const env = record(startup.env, '[host] startup.env')
	for (const [key, value] of Object.entries(env))
		if (value !== undefined && typeof value !== 'string')
			throw new TypeError(`[host] startup.env.${key} must be a string or undefined`)
	record(startup.bindings, '[host] startup.bindings')
	if (startup.deployment !== undefined) {
		const deployment = record(startup.deployment, '[host] startup.deployment')
		assertFields(deployment, new Set(['root', 'target', 'variant']), '[host] startup.deployment')
		if (typeof deployment.root !== 'string' || !isAbsolute(deployment.root))
			throw new TypeError('[host] startup.deployment.root must be absolute')
		if (
			deployment.target !== 'node' ||
			!['headless', 'workbench'].includes(deployment.variant as string)
		)
			throw new TypeError(
				'[host] startup.deployment requires target node and variant headless or workbench',
			)
	}
	return Object.freeze({
		...input,
		env: Object.freeze({ ...input.env }),
		bindings: Object.freeze({ ...input.bindings }),
		...(input.deployment ? { deployment: Object.freeze({ ...input.deployment }) } : {}),
	})
}

/** Evaluate a fresh application against an isolated startup snapshot. */
export async function resolveHostApplication(
	factory: HostApplicationFactory,
	input: HostStartupContext,
): Promise<ResolvedHostApplication> {
	if (typeof factory !== 'function') throw new TypeError('[host] Application must be a factory')
	const startup = snapshotStartup(input)
	const application = await factory(startup)
	assertHostApplication(application)
	recordLoadedApplicationPlugins(factory, application.plugins)
	const { envBindings: _envBindings, fileBindings: _fileBindings, ...resolved } = application
	const inputs = await resolveInputBindings(application, startup)
	return {
		...resolved,
		startup,
		vaultBindings: inputs.vaultBindings,
		configRecords: {
			...resolved.configRecords,
			initial: mergeConfigRecords(resolved.configRecords?.initial, inputs.base),
			baseSources: [...(resolved.configRecords?.baseSources ?? []), ...inputs.baseSources],
			overlays: [...(resolved.configRecords?.overlays ?? []), ...inputs.overlays],
		},
		plugins: [...application.plugins],
		...(application.sources
			? { sources: Object.freeze(application.sources.map(pluginSource)) }
			: {}),
		...(resolved.services ? { services: [...resolved.services] as readonly HostService[] } : {}),
		config: {
			...resolved.config,
			...(resolved.name && !resolved.config?.name ? { name: resolved.name } : {}),
		},
	}
}
/** The caller owns rollback and invokes this after attachments are ready and before Plugin admission. */
export async function prepareHostApplication(
	application: ResolvedHostApplication,
	host: PluginHost,
): Promise<void> {
	await application.prepare?.({ host, startup: application.startup })
}

/**
 * Start from a fresh Node launcher before importing the application or its business dependency graph.
 * Bind shared packages before evaluating the precompiled entry and its fixed imports. Node cannot
 * prove the bindings of transitive modules evaluated outside this loader; that preload is unsupported.
 */
export async function runHostApplication(
	entry: string,
	options: Readonly<{
		startup: Omit<HostStartupContext, 'deployment'>
		/** Packages whose public entries share the application's exact installation. Core/Host are always shared. */
		sharedPackages?: readonly string[]
	}>,
): Promise<PluginHost> {
	if (typeof entry !== 'string' || !entry.trim())
		throw new TypeError('[host] native application entry must be a module path')
	record(options, '[host] native application options')
	if (Object.hasOwn(record(options.startup, '[host] startup'), 'deployment'))
		throw new TypeError('[host] native module startup cannot declare a frozen deployment')
	for (const key of Object.keys(options))
		if (!['startup', 'sharedPackages'].includes(key))
			throw new TypeError(`[host] native application unsupported ${key}`)
	const startup = snapshotStartup(options.startup)
	if (options.sharedPackages !== undefined && !Array.isArray(options.sharedPackages))
		throw new TypeError('[host] sharedPackages must be an array')
	const sharedPackages = options.sharedPackages ? [...options.sharedPackages] : undefined
	const loader = await createNativeSourceLoader({
		root: startup.root,
		sharedPackages,
	})
	let host: PluginHost | undefined
	try {
		const application = await loader.loadApplication(resolve(startup.root, entry))
		const resolved = await resolveHostApplication(application, startup)
		const paths = await discoverPluginSources({
			root: resolved.startup.root,
			sources: resolved.sources ?? [],
		})
		const plugins = [...resolved.plugins]
		const seen = new Set(plugins)
		await loader.recordFixed(plugins)
		const facts = new Map<PluginConstructor, PluginCatalogProvenance>(
			plugins.map((plugin) => [
				plugin,
				{
					execution: {
						kind: 'native',
						origin: 'fixed',
						artifact: { kind: 'built-module' },
						update: { kind: 'next-start' },
					},
				},
			]),
		)
		for (const path of paths) {
			const definitions = await loader.load(path)
			for (const plugin of definitions)
				if (!seen.has(plugin)) {
					seen.add(plugin)
					plugins.push(plugin)
				}
			for (const plugin of definitions)
				if (!facts.has(plugin))
					facts.set(plugin, {
						moduleId: path,
						execution: {
							kind: 'native',
							origin: 'source',
							artifact: { kind: 'built-module' },
							update: { kind: 'next-start' },
						},
					})
		}
		host = await createHost({
			plugins,
			config: resolved.config,
			state: resolved.state,
			configRecords: resolved.configRecords,
			vaultBindings: resolved.vaultBindings,
			services: resolved.services,
		})
		setHostCatalogProvenance(host.ctx, facts)
		installPluginSources(host.ctx, {
			root: resolved.startup.root,
			sources: resolved.sources ?? [],
			updates: 'next-start',
		})
		host.ctx.effects.defer(() => loader.close(), { tag: 'NativeSourceLoader', phase: 'shutdown' })
		await prepareHostApplication(resolved, host)
		await host.start()
		return host
	} catch (error) {
		try {
			const [cleanup] = await Promise.allSettled([host?.close()])
			if (cleanup.status === 'rejected')
				throw new AggregateError(
					[error, cleanup.reason],
					'[host] application startup and cleanup failed',
					{ cause: error },
				)
		} finally {
			loader.close()
		}
		throw error
	}
}
