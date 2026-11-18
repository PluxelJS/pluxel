import { pluginNodeIndexKey, type PluginConstructor } from '@pluxel/core'
import {
	recordLoadedApplicationPlugins,
	readLoadedPluginModule,
	readLoadedApplicationControl,
	loadLoadedApplicationServiceControls,
} from './loaded-modules'
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
	mergeRecord,
	snapshotHostConfigRecords,
	assertDataObject,
	attachConfigProvenance,
	type ConfigDeclarationSource,
} from './config-records'
import { resolveInputBindings } from './input-bindings'
import { createNativeSourceLoader } from './native-source-loader'
import { discoverPluginSources } from './source-discovery'
import { installPluginSources, snapshotPluginSource } from './source-contract'
import { setHostCatalogProvenance } from './catalog-provenance'
import type { PluginCatalogProvenance } from './catalog'
import { createResolvedHost, type HostApplication, type PluginHost } from './host'
import {
	HOST_DECLARATION_FIELDS,
	snapshotHostDeclarations,
	type ResolvedHostOptions,
} from './node-declarations'
import { snapshotPolicyArray } from './policy-input'
import { startHostApplication } from './application-start'
export { prepareHostApplication } from './application-start'

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

export type ResolvedHostApplication = ResolvedHostOptions &
	Readonly<{
		/** Immutable shallow snapshot shared by the factory and prepare callback. */
		startup: HostStartupContext
		sources: NonNullable<HostApplication['sources']>
		prepare?: HostApplication['prepare']
		acceptStartup?: HostApplication['acceptStartup']
		launch?: HostApplication['launch']
	}>
const fields = [...HOST_DECLARATION_FIELDS, 'sources', 'prepare', 'acceptStartup', 'launch']
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
	assertDataObject(input, 'Application', fields)
	const app = input
	for (const key of ['prepare', 'acceptStartup', 'launch'])
		if (app[key] !== undefined && typeof app[key] !== 'function')
			throw new TypeError(`[host] Application ${key} must be a function`)
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
	const { options: resolved, bindings } = snapshotHostDeclarations(application)
	const sources = Object.freeze(
		application.sources === undefined
			? []
			: snapshotPolicyArray(application.sources, 'sources').map(snapshotPluginSource),
	)
	if (startup.deployment?.delivery === 'standalone' && sources.length > 0)
		throw new TypeError(
			'[host] Standalone application requires a fixed catalog; omit sources or use []',
		)
	recordLoadedApplicationPlugins(factory, resolved.plugins)
	const { prepare, acceptStartup, launch } = application
	if (bindings.envBindings.length === 0 && bindings.fileBindings.length === 0)
		return Object.freeze({ ...resolved, startup, sources, prepare, acceptStartup, launch })
	const inputs = await resolveInputBindings({ ...bindings, plugins: resolved.plugins }, startup)
	const records = new Map(
		resolved.config.records.map((item) => [pluginNodeIndexKey(item.owner), item]),
	)
	const fileSources = new Map<string, ConfigDeclarationSource[]>()
	for (const source of inputs.declarationSources) {
		const key = pluginNodeIndexKey(source.owner)
		const current = fileSources.get(key)
		if (current) current.push(source)
		else fileSources.set(key, [source])
	}
	const declarationsByNode = new Map<string, ConfigDeclarationSource[]>()
	const layers = [
		...inputs.records.map((entry) => ({
			entry,
			sources: fileSources.get(pluginNodeIndexKey(entry.owner)) ?? [],
		})),
		...inputs.overlays.map((entry) => ({
			entry,
			sources: entry.sources.map((source) => ({ owner: entry.owner, ...source })),
		})),
	]
	for (const { entry, sources: layerSources } of layers) {
		const key = pluginNodeIndexKey(entry.owner)
		const previous = records.get(key)
		const config = mergeRecord(previous?.config, entry.config)
		const declared = declarationsByNode.get(key) ?? []
		for (const path of configLeafPaths(entry.config)) {
			let selected: unknown = config
			for (const segment of path) selected = (selected as Record<string, unknown>)[segment]
			if (isConfigObject(selected) && Object.keys(selected).length > 0) continue
			for (let index = declared.length - 1; index >= 0; index--)
				if (configPathsOverlap(declared[index]!.path, path)) declared.splice(index, 1)
			const source = layerSources.find((fact) => configPathContains(fact.path, path))
			if (source) declared.push({ ...source, path: Object.freeze(path) })
		}
		records.set(key, { owner: entry.owner, mode: previous?.mode, config })
		declarationsByNode.set(key, declared)
	}
	const config = snapshotHostConfigRecords({ ...resolved.config, records: [...records.values()] })
	attachConfigProvenance(config, {
		sources: Object.freeze([...declarationsByNode.values()].flat()),
		bindings: inputs.bindings,
	})
	return Object.freeze({
		...resolved,
		startup,
		sources,
		prepare,
		acceptStartup,
		launch,
		vaultBindings: inputs.vaultBindings,
		config,
	})
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
	let resolved: ResolvedHostApplication
	try {
		const application = await loader.loadApplication(applicationEntry)
		resolved = await resolveHostApplication(application, startup)
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
					control:
						readLoadedApplicationControl(application, plugin) ??
						readLoadedPluginModule(plugin)?.control,
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
						control: readLoadedPluginModule(plugin)?.control,
						execution: {
							kind: 'native',
							origin: 'source',
							artifact: { kind: 'built-module' },
							update: { kind: 'next-start' },
						},
					})
		}
		host = await createResolvedHost({ ...resolved, plugins })
		await loadLoadedApplicationServiceControls(application, host.ctx, resolved.startup.root)
		setHostCatalogProvenance(host.ctx, facts)
		installPluginSources(host.ctx, {
			root: resolved.startup.root,
			sources: resolved.sources ?? [],
			updates: 'next-start',
		})
		host.ctx.effects.defer(() => loader.close(), { tag: 'NativeSourceLoader', phase: 'shutdown' })
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
	await startHostApplication(resolved, host)
	return host
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
