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
export type ResolvedHostApplication = HostRuntimeOptions &
	Readonly<{
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
	'configure',
	'prepare',
])
const runtimeFields = new Set(['services', 'config', 'state', 'configRecords'])
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
	if (app.configure !== undefined && typeof app.configure !== 'function')
		throw new TypeError('[host] Application configure must be a function')
	if (app.prepare !== undefined && typeof app.prepare !== 'function')
		throw new TypeError('[host] Application prepare must be a function')
}
/** Resolve fresh runtime configuration while retaining the statically declared Plugin catalog. */
export async function resolveHostApplication(
	application: HostApplication,
	startup: HostStartupContext,
): Promise<ResolvedHostApplication> {
	assertHostApplication(application)
	const runtime = record(
		(await application.configure?.(startup)) ?? {},
		'[host] configure() result',
	)
	assertFields(runtime, runtimeFields, '[host] configure() result')
	const { configure: _configure, ...fixed } = application
	const resolved = { ...fixed, ...runtime } as ResolvedHostApplication
	if (resolved.services !== undefined && !Array.isArray(resolved.services))
		throw new TypeError('[host] configure() services must be an array')
	return {
		...resolved,
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
	startup: HostStartupContext,
): Promise<void> {
	await application.prepare?.({ host, startup })
}

/** Run the same declaration outside Vite. No transport, environment globals, or default services are installed. */
export async function runHostApplication(
	application: HostApplication,
	options: Readonly<{
		startup: HostStartupContext
		frameworkModules?: Readonly<Record<string, string>>
	}>,
): Promise<PluginHost> {
	const resolved = await resolveHostApplication(application, options.startup)
	const loader = createProductionSourceLoader(options.frameworkModules)
	let host: PluginHost | undefined
	try {
		const common = {
			plugins: resolved.plugins,
			config: resolved.config,
			state: resolved.state,
			configRecords: resolved.configRecords,
			services: resolved.services,
		}
		host = await createHost(
			resolved.sources?.length
				? {
						...common,
						root: options.startup.root,
						sources: resolved.sources,
						loadModule: loader.load,
					}
				: common,
		)
		host.ctx.effects.defer(() => loader.close(), { tag: 'ProductionSourceLoader' })
		await prepareHostApplication(resolved, host, options.startup)
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
