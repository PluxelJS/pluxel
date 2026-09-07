import type { PluginConstructor } from '@pluxel/core'
import type {
	StaticRuntimeApplication,
	StaticRuntimeBindings,
	StaticRuntimeHostOptions,
	StaticRuntimeStartupContext,
} from './types.ts'
import { mergeConfigRecords, withPluginConfigEnvironment } from '@pluxel/runtime/internal'
import {
	assertKnownConfigFields,
	assertRuntimeServiceConfigFields,
	closedConfigFields,
	type ExactConfigShape,
} from '@pluxel/runtime/internal/config-validation'
import { resolveHostEnv } from '@pluxel/runtime/environment'
import { join } from 'pathe'
import { resolveConfigEnvironmentBootstrap } from './config-environment.ts'

const STATIC_RUNTIME_APPLICATION_MARKER = Symbol.for('pluxel.staticRuntimeApplication')

type MarkedStaticRuntimeApplication = StaticRuntimeApplication & {
	readonly [STATIC_RUNTIME_APPLICATION_MARKER]?: true
}

type ExactStaticRuntimeHostOptions<Options extends StaticRuntimeHostOptions> =
	Options extends unknown ? ExactConfigShape<Options, StaticRuntimeHostOptions> : never

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

const APPLICATION_FIELDS = closedConfigFields<StaticRuntimeApplication>({
	name: true,
	plugins: true,
	configEnvironmentBootstrap: true,
	configure: true,
	prepare: true,
})
const HOST_OPTION_FIELDS = closedConfigFields<StaticRuntimeHostOptions>({
	configService: true,
	runtimeState: true,
	persistence: true,
	database: true,
	workers: true,
	management: true,
	workbench: true,
	vault: true,
	debug: true,
	logging: true,
	profile: true,
})

export function defineStaticRuntime<
	const TPlugins extends readonly PluginConstructor[],
	TBindings extends StaticRuntimeBindings,
	const THostOptions extends StaticRuntimeHostOptions,
>(
	application: StaticRuntimeApplicationInput<TPlugins, TBindings, THostOptions> &
		ExactStaticRuntimeApplicationConstraint<THostOptions>,
): StaticRuntimeApplication<TPlugins, TBindings>
/** Compatibility overload for explicit type arguments; startup validation remains authoritative. */
export function defineStaticRuntime<
	const TPlugins extends readonly PluginConstructor[] = never,
	TBindings extends StaticRuntimeBindings = StaticRuntimeBindings,
>(
	application: [TPlugins] extends [never]
		? never
		: StaticRuntimeApplication<NoInfer<TPlugins>, NoInfer<TBindings>>,
): StaticRuntimeApplication<TPlugins, TBindings>
export function defineStaticRuntime(
	application: StaticRuntimeApplication<readonly PluginConstructor[], never>,
): StaticRuntimeApplication<readonly PluginConstructor[], never> {
	assertKnownConfigFields(application, APPLICATION_FIELDS, '[runtime-static] Static application')
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
	assertKnownConfigFields(options, HOST_OPTION_FIELDS, '[runtime-static] configure() result')
	assertRuntimeServiceConfigFields(options, '[runtime-static] configure() result')
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
