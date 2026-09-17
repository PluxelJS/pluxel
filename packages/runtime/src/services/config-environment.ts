import { coercePluginConfigRecords } from '@pluxel/host/internal'
export { coercePluginConfigRecords, mergeConfigRecords } from '@pluxel/host/internal'
import type { PluginConfigRecordSnapshot } from '@pluxel/core/services'
import type { ConfigServiceConfig } from './ConfigService'

const PLUGIN_CONFIG_ENV = 'PLUXEL_CONFIG'

export function withPluginConfigEnvironment(
	config: ConfigServiceConfig | undefined,
	environment: Readonly<Record<string, string | undefined>>,
): ConfigServiceConfig | undefined {
	if (config?.environment !== undefined) return config
	const snapshot = environment[PLUGIN_CONFIG_ENV]
	return snapshot === undefined
		? config
		: { ...config, environment: { [PLUGIN_CONFIG_ENV]: snapshot } }
}

export function configRecordsFromEnvironment(
	environment: false | Readonly<Record<string, string | undefined>> | undefined,
): PluginConfigRecordSnapshot[] {
	if (!environment) return []
	const text = environment[PLUGIN_CONFIG_ENV]
	if (text === undefined) return []
	let raw: unknown
	try {
		raw = JSON.parse(text)
	} catch (error) {
		throw new Error(`[ConfigService] ${PLUGIN_CONFIG_ENV} must contain JSON`, { cause: error })
	}
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		throw new Error(`[ConfigService] ${PLUGIN_CONFIG_ENV} must contain an object snapshot`)
	}
	const file = raw as Record<string, unknown>
	if (file.version !== 3 || !Array.isArray(file.plugins)) {
		throw new Error(`[ConfigService] ${PLUGIN_CONFIG_ENV} must contain config snapshot version 3`)
	}
	return coercePluginConfigRecords(file.plugins)
}
