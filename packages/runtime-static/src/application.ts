import type { PluginConstructor } from '@pluxel/core'
import type {
	StaticRuntimeApplication,
	StaticRuntimeBindings,
	StaticRuntimeHostOptions,
	StaticRuntimeStartupContext,
} from './types'

const STATIC_RUNTIME_APPLICATION_MARKER = Symbol.for('pluxel.staticRuntimeApplication')

type MarkedStaticRuntimeApplication = StaticRuntimeApplication & {
	readonly [STATIC_RUNTIME_APPLICATION_MARKER]?: true
}

const APPLICATION_FIELDS = new Set(['name', 'plugins', 'configure', 'prepare'])
const HOST_OPTION_FIELDS = new Set([
	'configService',
	'runtimeState',
	'persistence',
	'pluginData',
	'http',
	'workbench',
	'logging',
	'profile',
	'context',
])

export function defineStaticRuntime<
	const TPlugins extends readonly PluginConstructor[],
	TBindings extends StaticRuntimeBindings = StaticRuntimeBindings,
>(
	application: StaticRuntimeApplication<TPlugins, TBindings>,
): StaticRuntimeApplication<TPlugins, TBindings> {
	assertKnownFields(application, APPLICATION_FIELDS, '[runtime-static] Static application')
	if (!String(application.name ?? '').trim()) {
		throw new Error('[runtime-static] Static application name is required')
	}
	if (!Array.isArray(application.plugins)) {
		throw new TypeError('[runtime-static] Static application plugins must be an array')
	}
	if (application.configure !== undefined && typeof application.configure !== 'function') {
		throw new TypeError('[runtime-static] Static application configure must be a function')
	}
	if (application.prepare !== undefined && typeof application.prepare !== 'function') {
		throw new TypeError('[runtime-static] Static application prepare must be a function')
	}
	Object.defineProperty(application, STATIC_RUNTIME_APPLICATION_MARKER, {
		value: true,
		enumerable: false,
		configurable: false,
	})
	return application
}

export function isStaticRuntimeApplication(value: unknown): value is StaticRuntimeApplication {
	return Boolean(
		value &&
		typeof value === 'object' &&
		(value as MarkedStaticRuntimeApplication)[STATIC_RUNTIME_APPLICATION_MARKER] === true,
	)
}

export async function resolveStaticRuntimeHostOptions<TBindings extends StaticRuntimeBindings>(
	application: StaticRuntimeApplication<readonly PluginConstructor[], TBindings>,
	startup: StaticRuntimeStartupContext<TBindings>,
): Promise<StaticRuntimeHostOptions> {
	const options = (await application.configure?.(startup)) ?? {}
	if (!options || typeof options !== 'object' || Array.isArray(options)) {
		throw new TypeError('[runtime-static] Static application configure() must return an object')
	}
	assertKnownFields(options, HOST_OPTION_FIELDS, '[runtime-static] configure() result')
	assertPublicHttpConfig(options.http, '[runtime-static] configure() result')
	assertPublicContextConfig(options.context, '[runtime-static] configure() result')
	return options
}

function assertKnownFields(value: object, allowed: ReadonlySet<string>, label: string): void {
	const unknown = Object.keys(value).filter((key) => !allowed.has(key))
	if (unknown.length === 0) return
	throw new Error(`${label} includes unsupported ${unknown.map((key) => `"${key}"`).join(', ')}`)
}

function assertPublicHttpConfig(http: unknown, label: string): void {
	if (!http || typeof http !== 'object') return
	const forbidden = ['workbench', 'controlPlane', 'uiAssets', 'uiPublicDir'].filter(
		(key) => key in http,
	)
	if (forbidden.length === 0) return
	throw new Error(
		`${label} http must not include ${forbidden.map((key) => `"${key}"`).join(', ')}; use top-level "workbench" and let the route launcher own workbench internals.`,
	)
}

function assertPublicContextConfig(context: unknown, label: string): void {
	if (!context || typeof context !== 'object') return
	const forbidden = [
		'configService',
		'runtimeState',
		'persistence',
		'pluginData',
		'http',
		'workbench',
		'logger',
		'profile',
		'adminAccess',
		'workbenchArtifactRoot',
		'workbenchArtifactResolver',
		'nodeModuleArtifactRoot',
		'nodeModuleArtifactResolver',
	].filter((key) => key in context)
	if (forbidden.length > 0) {
		throw new Error(
			`${label} context must not include ${forbidden.map((key) => `"${key}"`).join(', ')}; use the corresponding top-level runtime option and let the route launcher own deployment internals.`,
		)
	}
}
