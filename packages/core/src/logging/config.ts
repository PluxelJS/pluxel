import type { Config } from '@logtape/logtape'
import { defaultLoggingConfig } from './default'
import type { RuntimeLoggingInput } from './logging'
import { normalizePluginLogPolicySnapshot } from './policy'
import { assertLoggingOptions, type LoggingOptions } from './service'
import { assertRuntimeLoggingInput } from './validation'

/** Use the Core preset or supply native input, optionally with independent policy options. */
export type LogTapeConfig =
	| RuntimeLoggingInput
	| Readonly<{
			input?: RuntimeLoggingInput
			options?: LoggingOptions
			sinks?: never
			loggers?: never
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

/** Capture the declaration while keeping native resources and callbacks borrowed. */
function snapshotLogTapeConfig(
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
	if (config && typeof config === 'object' && !Array.isArray(config)) {
		const keys = Reflect.ownKeys(config)
		if (keys.length === 0 || keys.includes('input') || keys.includes('options')) {
			const prototype = Object.getPrototypeOf(config)
			if (prototype !== Object.prototype && prototype !== null)
				throw new TypeError('[core.logtape] declaration must be a plain object')
			for (const key of keys) {
				if (key !== 'input' && key !== 'options')
					throw new TypeError(`[core.logtape] unknown declaration field: ${String(key)}`)
				const descriptor = Object.getOwnPropertyDescriptor(config, key)!
				if (!descriptor.enumerable || !('value' in descriptor))
					throw new TypeError('[core.logtape] declaration must contain only enumerable data fields')
			}
			const { input, options } = config as Exclude<LogTapeConfig, RuntimeLoggingInput>
			return snapshotLogTapeConfig(input, options)
		}
	}
	return snapshotLogTapeConfig(config as RuntimeLoggingInput)
}
