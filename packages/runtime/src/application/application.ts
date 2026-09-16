import type { PluginConstructor } from '@pluxel/core'
import type {
	RuntimeApplication,
	RuntimeBindings,
	RuntimeHostOptions,
	RuntimeStartupContext,
} from './types.ts'
import { mergeConfigRecords, withPluginConfigEnvironment } from '../internal.ts'
import {
	assertKnownConfigFields,
	assertRuntimeServiceConfigFields,
	closedConfigFields,
} from '../internal-config-validation.ts'
import { resolveHostEnv } from '../environment.ts'
import { join } from 'pathe'
import { resolveConfigEnvironmentBootstrap } from './config-environment.ts'

const APPLICATION_FIELDS = closedConfigFields<RuntimeApplication>({
	name: true,
	plugins: true,
	sources: true,
	configEnvironmentBootstrap: true,
	configure: true,
	prepare: true,
})
const HOST_OPTION_FIELDS = closedConfigFields<RuntimeHostOptions>({
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

export function assertRuntimeApplication(
	application: unknown,
): asserts application is RuntimeApplication {
	if (!application || typeof application !== 'object' || Array.isArray(application)) {
		throw new TypeError('[runtime] Application must be a plain object')
	}
	const input = application as RuntimeApplication
	assertKnownConfigFields(application, APPLICATION_FIELDS, '[runtime] Application')
	if (!String(input.name ?? '').trim()) {
		throw new Error('[runtime] Application name is required')
	}
	if (!Array.isArray(input.plugins)) {
		throw new TypeError('[runtime] Application plugins must be an array')
	}
	if (
		input.configEnvironmentBootstrap !== undefined &&
		!Array.isArray(input.configEnvironmentBootstrap)
	) {
		throw new TypeError('[runtime] Application configEnvironmentBootstrap must be an array')
	}
	if (
		input.sources !== undefined &&
		(!Array.isArray(input.sources) ||
			input.sources.some(
				(source) =>
					!source || typeof source.open !== 'function' || typeof source.covers !== 'function',
			))
	) {
		throw new TypeError('[runtime] sources must contain PluginSource descriptions')
	}
	if (input.configure !== undefined && typeof input.configure !== 'function') {
		throw new TypeError('[runtime] Application configure must be a function')
	}
	if (input.prepare !== undefined && typeof input.prepare !== 'function') {
		throw new TypeError('[runtime] Application prepare must be a function')
	}
}

export function isRuntimeApplication(value: unknown): value is RuntimeApplication {
	try {
		assertRuntimeApplication(value)
		return true
	} catch {
		return false
	}
}

export async function resolveRuntimeHostOptions<TBindings extends RuntimeBindings>(
	application: RuntimeApplication<readonly PluginConstructor[], TBindings>,
	startup: RuntimeStartupContext<TBindings>,
	defaults: Readonly<{ workbench?: boolean }> = {},
): Promise<RuntimeHostOptions> {
	const environmentSeed = resolveConfigEnvironmentBootstrap(application, startup.env)
	const options = (await application.configure?.(startup)) ?? {}
	if (!options || typeof options !== 'object' || Array.isArray(options)) {
		throw new TypeError('[runtime] Application configure() must return an object')
	}
	assertKnownConfigFields(options, HOST_OPTION_FIELDS, '[runtime] configure() result')
	assertRuntimeServiceConfigFields(options, '[runtime] configure() result')
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
	const workbench: RuntimeHostOptions['workbench'] =
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
