import type { PluginConstructor } from '@pluxel/core'
import type {
	StaticRuntimeApplication,
	StaticRuntimeBindings,
	StaticRuntimeHostOptions,
	StaticRuntimeStartupContext,
} from './types.ts'
import { mergeConfigRecords, withPluginConfigEnvironment } from '@pluxel/runtime/internal'
import {
	resolveRuntimePlanePlan,
	type ExactConfigProperty,
	type ExactConfigShape,
} from '@pluxel/runtime/internal/static-host'
import { resolveHostEnv } from '@pluxel/runtime/environment'
import { join } from 'pathe'
import { resolveConfigEnvironmentBootstrap } from './config-environment.ts'

const STATIC_RUNTIME_APPLICATION_MARKER = Symbol.for('pluxel.staticRuntimeApplication')

type MarkedStaticRuntimeApplication = StaticRuntimeApplication & {
	readonly [STATIC_RUNTIME_APPLICATION_MARKER]?: true
}

type ExactStaticRuntimeHostOptions<Options extends StaticRuntimeHostOptions> =
	Options extends unknown
		? ExactConfigShape<Options, StaticRuntimeHostOptions> extends never
			? never
			: ExactConfigProperty<Options, 'workbench', StaticRuntimeHostOptions['workbench']>
		: never

type StaticRuntimeApplicationInput<
	TPlugins extends readonly PluginConstructor[],
	TBindings extends StaticRuntimeBindings,
	THostOptions extends StaticRuntimeHostOptions,
> = Omit<StaticRuntimeApplication<TPlugins, TBindings>, 'configure'> & {
	/** Bundled resolver code. Returned values are resolved again for every host startup. */
	configure?: (
		startup: StaticRuntimeStartupContext<TBindings>,
	) => THostOptions | Promise<THostOptions>
}

type ExactStaticRuntimeApplicationConstraint<THostOptions extends StaticRuntimeHostOptions> = [
	THostOptions,
] extends [ExactStaticRuntimeHostOptions<THostOptions>]
	? unknown
	: { configure?: never }

const APPLICATION_FIELDS = new Set([
	'name',
	'plugins',
	'configEnvironmentBootstrap',
	'configure',
	'prepare',
])
const HOST_OPTION_FIELDS = new Set([
	'configService',
	'runtimeState',
	'persistence',
	'database',
	'workers',
	'management',
	'workbench',
	'vault',
	'debug',
	'logging',
	'profile',
])

export function defineStaticRuntime<
	const TPlugins extends readonly PluginConstructor[],
	TBindings extends StaticRuntimeBindings,
	const THostOptions extends StaticRuntimeHostOptions,
>(
	application: StaticRuntimeApplicationInput<TPlugins, TBindings, THostOptions> &
		ExactStaticRuntimeApplicationConstraint<THostOptions>,
): StaticRuntimeApplication<TPlugins, TBindings> {
	assertKnownFields(application, APPLICATION_FIELDS, '[runtime-static] Static application')
	if (!String(application.name ?? '').trim()) {
		throw new Error('[runtime-static] Static application name is required')
	}
	if (!Array.isArray(application.plugins)) {
		throw new TypeError('[runtime-static] Static application plugins must be an array')
	}
	if (
		application.configEnvironmentBootstrap !== undefined &&
		!Array.isArray(application.configEnvironmentBootstrap)
	) {
		throw new TypeError(
			'[runtime-static] Static application configEnvironmentBootstrap must be an array',
		)
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
	defaults: Readonly<{ workbench?: boolean }> = {},
): Promise<StaticRuntimeHostOptions> {
	const environmentSeed = resolveConfigEnvironmentBootstrap(application, startup.env)
	const options = (await application.configure?.(startup)) ?? {}
	if (!options || typeof options !== 'object' || Array.isArray(options)) {
		throw new TypeError('[runtime-static] Static application configure() must return an object')
	}
	assertKnownFields(options, HOST_OPTION_FIELDS, '[runtime-static] configure() result')
	resolveRuntimePlanePlan(options.workbench, options.management)
	const environment = resolveHostEnv(startup.env)
	const seededConfigService =
		environmentSeed.length === 0
			? options.configService
			: {
					...options.configService,
					snapshot: {
						...options.configService?.snapshot,
						plugins: mergeConfigRecords(options.configService?.snapshot?.plugins, environmentSeed),
					},
				}
	const configService = withPluginConfigEnvironment(seededConfigService, startup.env)
	const workbench: StaticRuntimeHostOptions['workbench'] =
		environment.workbench === false
			? false
			: environment.workbench === true
				? {
						...(typeof options.workbench === 'object' ? options.workbench : {}),
						enabled: true,
					}
				: (options.workbench ?? (defaults.workbench ? { enabled: true } : undefined))
	return {
		...options,
		...(configService === options.configService ? {} : { configService }),
		...(startup.env.PLUXEL_DATA_ROOT !== undefined &&
		(options.persistence === undefined || typeof options.persistence === 'string')
			? { persistence: join(environment.dataRoot, 'persistence') }
			: {}),
		...(workbench === undefined ? {} : { workbench }),
	}
}

function assertKnownFields(value: object, allowed: ReadonlySet<string>, label: string): void {
	const unknown = Object.keys(value).filter((key) => !allowed.has(key))
	if (unknown.length === 0) return
	throw new Error(`${label} includes unsupported ${unknown.map((key) => `"${key}"`).join(', ')}`)
}
