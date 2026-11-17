import type { Config } from '@logtape/logtape'
import { defaultLoggingConfig } from '../logging/default'
import type { RuntimeLoggingInput } from '../logging/logging'
import { normalizePluginLogPolicySnapshot } from '../logging/policy'
import { assertLoggingOptions, type LoggingOptions } from '../logging/service'
import { assertRuntimeLoggingInput } from '../logging/validation'

/** Native configuration, or native input with independent framework policy options. */
export type LogTapeConfig =
	| RuntimeLoggingInput
	| Readonly<{
			input: RuntimeLoggingInput
			options?: LoggingOptions
	  }>

/** Captured native input; resources remain borrowed until Core prepares this owner. */
export type ResolvedLogTapeConfig = Readonly<{
	input: RuntimeLoggingInput
	options: LoggingOptions
}>

function snapshotNativeConfig(config: Config<string, string>): Config<string, string> {
	if (config.reset === true)
		throw new TypeError('RuntimeLogging owns installation; native reset:true is not allowed')
	const loggers = config.loggers.map((logger) => {
		const snapshot = {
			...logger,
			...(Array.isArray(logger.category) ? { category: [...logger.category] } : {}),
			...(logger.sinks ? { sinks: [...logger.sinks] } : {}),
			...(logger.filters ? { filters: [...logger.filters] } : {}),
		}
		if (Array.isArray(snapshot.category)) Object.freeze(snapshot.category)
		if (snapshot.sinks) Object.freeze(snapshot.sinks)
		if (snapshot.filters) Object.freeze(snapshot.filters)
		return Object.freeze(snapshot)
	})
	Object.freeze(loggers)
	return Object.freeze({
		...config,
		sinks: Object.freeze({ ...config.sinks }),
		...(config.filters ? { filters: Object.freeze({ ...config.filters }) } : {}),
		loggers,
	})
}

/**
 * Declare one Core-owned native LogTape installation without IO. Native resource
 * references are retained; a factory runs once during preparation, with access
 * to the root identity and optional bounded store sink. Custom input replaces
 * the default native console and bounded store preset completely.
 */
export function logtape(
	input: RuntimeLoggingInput = defaultLoggingConfig,
	options: LoggingOptions = {},
): ResolvedLogTapeConfig {
	assertRuntimeLoggingInput(input, '[core.logtape] config')
	assertLoggingOptions(options)
	const initialPluginPolicy = options.initialPluginPolicy
		? normalizePluginLogPolicySnapshot(options.initialPluginPolicy)
		: undefined
	if (initialPluginPolicy) {
		for (const override of initialPluginPolicy.overrides) Object.freeze(override)
		Object.freeze(initialPluginPolicy.overrides)
		Object.freeze(initialPluginPolicy)
	}
	return Object.freeze({
		input: typeof input === 'function' ? input : snapshotNativeConfig(input),
		options: Object.freeze({
			...options,
			profile: options.profile ?? 'pluxel',
			...(options.debugTopics ? { debugTopics: Object.freeze([...options.debugTopics]) } : {}),
			...(initialPluginPolicy ? { initialPluginPolicy } : {}),
		}),
	})
}

/** @internal Capture either public input shape without invoking its factories. */
export function resolveLogTapeConfig(
	config: LogTapeConfig | undefined,
): ResolvedLogTapeConfig | undefined {
	if (config === undefined) return undefined
	if (config && typeof config === 'object' && 'input' in config) {
		for (const key of Object.keys(config))
			if (key !== 'input' && key !== 'options')
				throw new TypeError(`[core.logtape] unknown declaration field: ${key}`)
		return logtape(config.input, config.options)
	}
	return logtape(config as RuntimeLoggingInput)
}
