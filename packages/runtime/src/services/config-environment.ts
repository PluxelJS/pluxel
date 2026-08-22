import { parsePluginNodeAddress, pluginNodeAddressEqual } from '@pluxel/core'
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

export function mergeConfigRecords(
	base: readonly PluginConfigRecordSnapshot[] | undefined,
	override: readonly PluginConfigRecordSnapshot[] | undefined,
): PluginConfigRecordSnapshot[] {
	const merged: PluginConfigRecordSnapshot[] = []
	for (const entry of base ?? []) upsert(merged, entry)
	for (const entry of override ?? []) upsert(merged, entry)
	return merged
}

export function coercePluginConfigRecords(input: unknown): PluginConfigRecordSnapshot[] {
	if (!Array.isArray(input)) throw new Error('[ConfigService] Persisted plugins must be an array')
	const out: PluginConfigRecordSnapshot[] = []
	for (let index = 0; index < input.length; index++) {
		const raw = input[index]
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
			throw new Error(`[ConfigService] plugins[${index}] must be an object`)
		}
		const record = raw as Record<string, unknown>
		const owner = parsePluginNodeAddress(record.owner)
		if (!record.config || typeof record.config !== 'object' || Array.isArray(record.config)) {
			throw new Error(`[ConfigService] plugins[${index}].config must be an object`)
		}
		if (out.some((entry) => pluginNodeAddressEqual(entry.owner, owner))) {
			throw new Error(`[ConfigService] plugins[${index}] duplicates a Plugin node owner`)
		}
		out.push({ owner, config: { ...(record.config as Record<string, unknown>) } })
	}
	return out
}

function upsert(target: PluginConfigRecordSnapshot[], input: PluginConfigRecordSnapshot): void {
	const owner = parsePluginNodeAddress(input.owner)
	const index = target.findIndex((entry) => pluginNodeAddressEqual(entry.owner, owner))
	const previous = index < 0 ? undefined : target[index]
	const entry = {
		owner,
		config: mergeRecord(previous?.config, input.config),
	}
	if (index < 0) target.push(entry)
	else target[index] = entry
}

function mergeRecord(
	base: Readonly<Record<string, unknown>> | undefined,
	override: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> {
	const merged: Record<string, unknown> = Object.create(null)
	for (const [key, value] of Object.entries(base ?? {})) merged[key] = clone(value)
	for (const [key, value] of Object.entries(override ?? {})) {
		merged[key] =
			isRecord(merged[key]) && isRecord(value) ? mergeRecord(merged[key], value) : clone(value)
	}
	return merged
}

function clone(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(clone)
	return isRecord(value) ? mergeRecord(undefined, value) : value
}

function isRecord(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false
	const prototype = Object.getPrototypeOf(value)
	return prototype === Object.prototype || prototype === null
}
