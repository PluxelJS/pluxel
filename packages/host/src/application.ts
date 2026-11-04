import { recordLoadedApplicationPlugins } from './loaded-modules'
import { snapshotHostRuntime } from './runtime'
import { snapshotHostPolicy } from './state-store'
import {
	configLeafPaths,
	configPathContains,
	configPathsOverlap,
	isConfigObject,
} from './config-paths'
import { dirname, isAbsolute, resolve } from 'node:path'
import { readFile, realpath } from 'node:fs/promises'
import { installedPackageFacts } from './shared-packages'
import {
	mergeConfigRecords,
	snapshotHostConfig,
	attachConfigProvenance,
	type ConfigDeclarationSource,
} from './config-records'
import { resolveInputBindings } from './input-bindings'
import { createNativeSourceLoader } from './native-source-loader'
import { discoverPluginSources } from './source-discovery'
import { installPluginSources, pluginSource } from './source-contract'
import { setHostCatalogProvenance } from './catalog-provenance'
import type { PluginCatalogProvenance } from './catalog'
import { pluginNodeAddressEqual, type PluginConstructor } from '@pluxel/core'
import { createHost, type HostApplication, type HostOptions, type PluginHost } from './host'

export type HostStartupContext<
	TBindings extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>,
> = Readonly<{
	root: string
	mode: 'development' | 'production' | 'test'
	env: Readonly<Record<string, string | undefined>>
	bindings: TBindings
	deployment?: Readonly<{
		root: string
		target: 'node'
		delivery: 'standalone' | 'modules'
		variant: 'headless' | 'workbench'
		application?: Readonly<{ name: string; catalogHash: string }>
	}>
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

export type ResolvedHostApplication = Omit<HostOptions, 'plugins'> &
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
	'runtime',
	'policy',
	'config',
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
function assertApplicationShape(input: unknown): asserts input is HostApplication {
	const app = record(input, '[host] Application')
	assertFields(app, fields, '[host] Application')
	if (!Array.isArray(app.plugins))
		throw new TypeError('[host] Application plugins must be an array')
	if (app.sources !== undefined) {
		if (!Array.isArray(app.sources))
			throw new TypeError('[host] Application sources must be an array')
	}
	if (app.services !== undefined && !Array.isArray(app.services))
		throw new TypeError('[host] Application services must be an array')
	for (const key of ['envBindings', 'fileBindings'])
		if (app[key] !== undefined && !Array.isArray(app[key]))
			throw new TypeError(`[host] Application ${key} must be an array`)
	if (app.name !== undefined && (typeof app.name !== 'string' || !app.name.trim()))
		throw new TypeError('[host] Application name must be a non-empty string')
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
		assertFields(
			deployment,
			new Set(['root', 'target', 'delivery', 'variant', 'application']),
			'[host] startup.deployment',
		)
		if (deployment.application !== undefined) assertApplicationFacts(deployment.application)
		if (typeof deployment.root !== 'string' || !isAbsolute(deployment.root))
			throw new TypeError('[host] startup.deployment.root must be absolute')
		if (
			deployment.target !== 'node' ||
			!['standalone', 'modules'].includes(deployment.delivery as string) ||
			!['headless', 'workbench'].includes(deployment.variant as string)
		)
			throw new TypeError(
				'[host] startup.deployment requires target node, delivery standalone or modules, and variant headless or workbench',
			)
	}
	return Object.freeze({
		...input,
		env: Object.freeze({ ...input.env }),
		bindings: Object.freeze({ ...input.bindings }),
		...(input.deployment
			? {
					deployment: Object.freeze({
						...input.deployment,
						...(input.deployment.application
							? { application: Object.freeze({ ...input.deployment.application }) }
							: {}),
					}),
				}
			: {}),
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
	assertApplicationShape(application)
	recordLoadedApplicationPlugins(factory, application.plugins)
	const { envBindings, fileBindings, ...declaration } = application
	const resolved = {
		...declaration,
		plugins: [...application.plugins],
		...(application.sources
			? { sources: Object.freeze(application.sources.map(pluginSource)) }
			: {}),
		...(application.services ? { services: [...application.services] } : {}),
		runtime: snapshotHostRuntime(application.runtime),
		config: snapshotHostConfig(application.config),
		policy: snapshotHostPolicy(application.policy),
	}
	const inputs = await resolveInputBindings(
		{
			...resolved,
			...(envBindings ? { envBindings: [...envBindings] } : {}),
			...(fileBindings ? { fileBindings: [...fileBindings] } : {}),
		},
		startup,
	)
	const merged = mergeConfigRecords(
		mergeConfigRecords(
			resolved.config.records.flatMap((item) =>
				item.config === undefined ? [] : [{ owner: item.owner, config: item.config }],
			),
			inputs.records,
		),
		inputs.overlays,
	)
	const config = snapshotHostConfig({
		mode: resolved.config.mode,
		records: [
			...resolved.config.records.map((item) => ({
				...item,
				config: merged.find((entry) => pluginNodeAddressEqual(entry.owner, item.owner))?.config,
			})),
			...merged.filter(
				(entry) =>
					!resolved.config.records.some((item) => pluginNodeAddressEqual(item.owner, entry.owner)),
			),
		],
	})
	const sources: ConfigDeclarationSource[] = []
	const declared = mergeConfigRecords(
		undefined,
		resolved.config.records.flatMap((item) =>
			item.config === undefined ? [] : [{ owner: item.owner, config: item.config }],
		),
	)
	const layers = [
		...inputs.records.map((entry) => ({
			entry,
			sources: inputs.declarationSources.filter((source) =>
				pluginNodeAddressEqual(source.owner, entry.owner),
			),
		})),
		...inputs.overlays.map((entry) => ({
			entry,
			sources: entry.sources.map((source) => ({ owner: entry.owner, ...source })),
		})),
	]
	for (const layer of layers) {
		const before = declared.find((entry) =>
			pluginNodeAddressEqual(entry.owner, layer.entry.owner),
		)?.config
		const after = mergeConfigRecords(
			before === undefined ? [] : [{ owner: layer.entry.owner, config: before }],
			[layer.entry],
		)[0]!
		for (const path of configLeafPaths(layer.entry.config)) {
			let selected: unknown = after.config
			for (const key of path) selected = (selected as Record<string, unknown>)[key]
			if (isConfigObject(selected) && Object.keys(selected).length > 0) continue
			for (let index = sources.length - 1; index >= 0; index--)
				if (
					pluginNodeAddressEqual(sources[index]!.owner, layer.entry.owner) &&
					configPathsOverlap(sources[index]!.path, path)
				)
					sources.splice(index, 1)
			const source = layer.sources.find((fact) => configPathContains(fact.path, path))
			if (source) sources.push({ ...source, path: Object.freeze(path) })
		}
		const index = declared.findIndex((entry) => pluginNodeAddressEqual(entry.owner, after.owner))
		if (index < 0) declared.push(after)
		else declared[index] = after
	}
	attachConfigProvenance(config, { sources: Object.freeze(sources), bindings: inputs.bindings })
	return { ...resolved, startup, vaultBindings: inputs.vaultBindings, config }
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
	let startup = snapshotStartup(options.startup)
	const applicationEntry = await realpath(resolve(startup.root, entry))
	const deployment = await readModuleDeployment(applicationEntry)
	if (deployment) startup = snapshotStartup({ ...startup, deployment })
	if (options.sharedPackages !== undefined && !Array.isArray(options.sharedPackages))
		throw new TypeError('[host] sharedPackages must be an array')
	const sharedPackages = options.sharedPackages ? [...options.sharedPackages] : undefined
	const loader = await createNativeSourceLoader({
		root: startup.root,
		sharedPackages,
	})
	let host: PluginHost | undefined
	try {
		const application = await loader.loadApplication(applicationEntry)
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
			name: resolved.name,
			runtime: resolved.runtime,
			policy: resolved.policy,
			config: resolved.config,
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

/** Native module deliveries carry the same compiled application identity as static deliveries. */
async function readModuleDeployment(entry: string): Promise<HostStartupContext['deployment']> {
	const root = installedPackageFacts(entry)?.root ?? dirname(entry)
	let text: string
	try {
		text = await readFile(resolve(root, 'pluxel-deployment.json'), 'utf8')
	} catch (error) {
		if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
			return undefined
		throw error
	}
	const manifest = record(JSON.parse(text), '[host] module deployment')
	if (manifest.version !== 1 || manifest.kind !== 'pluxel-modules-application')
		throw new TypeError(
			'[host] Native module startup requires a modules application deployment manifest',
		)
	const application = record(manifest.application, '[host] module deployment.application')
	assertApplicationFacts(application)
	const server = record(manifest.server, '[host] module deployment.server')
	if (
		server.target !== 'node' ||
		typeof server.entry !== 'string' ||
		resolve(root, server.entry) !== entry
	)
		throw new TypeError('[host] Module deployment entry does not match the loaded application')
	const capabilities = record(manifest.capabilities, '[host] module deployment.capabilities')
	const workbench = record(
		capabilities.workbench,
		'[host] module deployment.capabilities.workbench',
	)
	if (typeof workbench.included !== 'boolean')
		throw new TypeError('[host] Module deployment must declare its workbench variant')
	return {
		root,
		target: 'node',
		delivery: 'modules',
		variant: workbench.included ? 'workbench' : 'headless',
		application,
	}
}

function assertApplicationFacts(
	input: unknown,
): asserts input is { name: string; catalogHash: string } {
	const value = record(input, '[host] deployment.application')
	if (
		Object.keys(value).some((key) => !['name', 'catalogHash'].includes(key)) ||
		typeof value.name !== 'string' ||
		!value.name ||
		value.name.length > 256 ||
		typeof value.catalogHash !== 'string' ||
		!/^[0-9a-f]{64}$/.test(value.catalogHash)
	)
		throw new TypeError('[host] deployment.application requires a name and SHA-256 catalogHash')
}
