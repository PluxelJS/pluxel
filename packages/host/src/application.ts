import { mergeConfigRecords } from './config-records'
import { resolveInputBindings } from './input-bindings'
import { createProductionSourceLoader } from './production-source-loader'
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
	if (app.sources !== undefined && !Array.isArray(app.sources))
		throw new TypeError('[host] Application sources must be an array')
	if (app.services !== undefined && !Array.isArray(app.services))
		throw new TypeError('[host] Application services must be an array')
	for (const key of ['envBindings', 'fileBindings'])
		if (app[key] !== undefined && !Array.isArray(app[key]))
			throw new TypeError(`[host] Application ${key} must be an array`)
	if (app.prepare !== undefined && typeof app.prepare !== 'function')
		throw new TypeError('[host] Application prepare must be a function')
}
/** Evaluate a fresh application against an isolated startup snapshot. */
export async function resolveHostApplication(
	factory: HostApplicationFactory,
	input: HostStartupContext,
): Promise<ResolvedHostApplication> {
	if (typeof factory !== 'function') throw new TypeError('[host] Application must be a factory')
	const startup: HostStartupContext = Object.freeze({
		...input,
		env: Object.freeze({ ...input.env }),
		bindings: Object.freeze({ ...input.bindings }),
		...(input.deployment ? { deployment: Object.freeze({ ...input.deployment }) } : {}),
	})
	const application = await factory(startup)
	assertHostApplication(application)
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
		...(application.sources ? { sources: [...application.sources] } : {}),
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

/** Run the same declaration outside Vite. No transport, environment globals, or default services are installed. */
export async function runHostApplication(
	application: HostApplicationFactory,
	options: Readonly<{
		startup: HostStartupContext
		frameworkModules?: Readonly<Record<string, string>>
		/** Exact Workbench transport version embedded by a production application build. */
		workbenchCapnwebVersion?: string
	}>,
): Promise<PluginHost> {
	const resolved = await resolveHostApplication(application, options.startup)
	const loader = createProductionSourceLoader(
		options.frameworkModules,
		options.workbenchCapnwebVersion,
	)
	let host: PluginHost | undefined
	try {
		const common = {
			plugins: resolved.plugins,
			config: resolved.config,
			state: resolved.state,
			configRecords: resolved.configRecords,
			vaultBindings: resolved.vaultBindings,
			services: resolved.services,
		}
		host = await createHost(
			resolved.sources?.length
				? {
						...common,
						root: resolved.startup.root,
						sources: resolved.sources,
						loadModule: loader.load,
					}
				: common,
		)
		host.ctx.effects.defer(() => loader.close(), { tag: 'ProductionSourceLoader' })
		await prepareHostApplication(resolved, host)
		await host.start()
		return host
	} catch (error) {
		try {
			await host?.close()
		} catch (cleanup) {
			throw new AggregateError([error, cleanup], '[host] application startup and cleanup failed', {
				cause: cleanup,
			})
		} finally {
			loader.close()
		}
		throw error
	}
}
