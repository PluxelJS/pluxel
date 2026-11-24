import type { PluginConstructor } from '@pluxel/core'
import { snapshotCoreFacilitiesConfig } from '@pluxel/core/host'
import {
	recordLoadedApplicationPlugins,
	readLoadedPluginModule,
	readLoadedApplicationControl,
	loadLoadedApplicationServiceControls,
} from './loaded-modules'
import { dirname, isAbsolute, resolve } from 'node:path'
import { readFile, realpath } from 'node:fs/promises'
import { installedPackageFacts } from './shared-packages'
import { resolveApplicationBindings } from './input-bindings'
import { createNativeSourceLoader } from './native-source-loader'
import { discoverPluginSources } from './source-discovery'
import { installPluginSources, snapshotPluginSource } from './source-contract'
import { setHostCatalogProvenance } from './catalog-provenance'
import type { PluginCatalogProvenance } from './catalog'
import { createResolvedHost, type HostApplication, type PluginHost } from './host'
import {
	assertApplicationShape,
	snapshotHostDeclarations,
	type ResolvedHostOptions,
} from './node-declarations'
import { snapshotPolicyArray } from './policy-input'
import { startHostApplication } from './application-start'
import { declareApplication, type ApplicationDefinition } from './application-factory'
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

/** Node applications receive the full loader startup context. */
export const defineHostApplication: ApplicationDefinition<HostApplicationFactory> =
	declareApplication

export type ResolvedHostApplication = ResolvedHostOptions &
	Readonly<{
		/** Immutable shallow snapshot shared by the factory and prepare callback. */
		startup: HostStartupContext
		sources: NonNullable<HostApplication['sources']>
		prepare?: HostApplication['prepare']
		acceptStartup?: HostApplication['acceptStartup']
		launch?: HostApplication['launch']
	}>
function record(input: unknown, label: string): Record<string, unknown> {
	if (!input || typeof input !== 'object' || Array.isArray(input))
		throw new TypeError(`${label} must be an object`)
	return input as Record<string, unknown>
}
function assertFields(input: Record<string, unknown>, allowed: Set<string>, label: string): void {
	for (const key of Object.keys(input))
		if (!allowed.has(key)) throw new TypeError(`${label} includes unsupported "${key}"`)
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
	return evaluateHostApplication(factory, snapshotStartup(input))
}

async function evaluateHostApplication(
	factory: HostApplicationFactory,
	startup: HostStartupContext,
): Promise<ResolvedHostApplication> {
	const application = await factory(startup)
	assertApplicationShape(application, 'managed')
	const { options, bindings } = snapshotHostDeclarations(application)
	const resolved = { ...options, coreConfig: snapshotCoreFacilitiesConfig(application.coreConfig) }
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
	const bound = await resolveApplicationBindings(resolved, bindings, startup.env, (path) =>
		readFile(resolve(startup.root, path), 'utf8'),
	)
	return Object.freeze({ ...bound, startup, sources, prepare, acceptStartup, launch })
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
	const input = snapshotStartup(options.startup)
	if (options.sharedPackages !== undefined && !Array.isArray(options.sharedPackages))
		throw new TypeError('[host] sharedPackages must be an array')
	const sharedPackages = options.sharedPackages ? [...options.sharedPackages] : undefined
	const applicationEntry = await realpath(resolve(input.root, entry))
	const deployment = await readModuleDeployment(applicationEntry)
	const startup = deployment ? Object.freeze({ ...input, deployment }) : input
	const loader = await createNativeSourceLoader({
		root: startup.root,
		sharedPackages,
	})
	let host: PluginHost | undefined
	let resolved: ResolvedHostApplication
	try {
		const application = await loader.loadApplication(applicationEntry)
		resolved = await evaluateHostApplication(application, startup)
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
		host = await createResolvedHost({ ...resolved, plugins }, applicationEntry)
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
	return Object.freeze({
		root,
		target: 'node',
		delivery: 'modules',
		variant: workbench.included ? 'workbench' : 'headless',
		application: Object.freeze(application),
	})
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
