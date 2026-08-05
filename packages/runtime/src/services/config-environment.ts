import type { ConfigServiceConfig } from './ConfigService'

const PLUGIN_CONFIG_ENV_PREFIX = 'PLUXEL_CONFIG__'
const FORBIDDEN_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor'])

type ConfigRecord = Record<string, unknown>

export function withPluginConfigEnvironment(
	config: ConfigServiceConfig | undefined,
	environment: Readonly<Record<string, string | undefined>>,
): ConfigServiceConfig | undefined {
	if (config?.environment !== undefined) return config
	const selected = Object.fromEntries(
		Object.entries(environment).filter(
			([name, value]) => name.startsWith(PLUGIN_CONFIG_ENV_PREFIX) && value !== undefined,
		),
	)
	if (Object.keys(selected).length === 0) return config
	return { ...config, environment: selected }
}

export function configRecordsFromEnvironment(
	environment: false | Readonly<Record<string, string | undefined>> | undefined,
): Record<string, ConfigRecord> {
	const plugins: Record<string, ConfigRecord> = Object.create(null)
	if (!environment) return plugins

	const entries = Object.entries(environment)
		.filter(([name, value]) => name.startsWith(PLUGIN_CONFIG_ENV_PREFIX) && value !== undefined)
		.sort(([left], [right]) => left.localeCompare(right))
	for (const [name, value] of entries) {
		const path = name.slice(PLUGIN_CONFIG_ENV_PREFIX.length).split('__')
		if (path.length < 2 || path.some((segment) => !segment)) {
			throw new Error(
				`[ConfigService] Invalid plugin config environment name "${name}"; expected ${PLUGIN_CONFIG_ENV_PREFIX}<plugin-id>__<schema-key>[__<field>...]`,
			)
		}
		if (path.some((segment) => FORBIDDEN_PATH_SEGMENTS.has(segment))) {
			throw new Error(`[ConfigService] Unsafe plugin config environment path: ${name}`)
		}

		const pluginName = path.shift()!
		const plugin = (plugins[pluginName] ??= Object.create(null))
		writeConfigPath(plugin, path, decodeEnvironmentValue(value! as string), name)
	}
	return plugins
}

export function mergeConfigRecords(
	base: Readonly<Record<string, ConfigRecord>> | undefined,
	override: Readonly<Record<string, ConfigRecord>> | undefined,
): Record<string, ConfigRecord> {
	const plugins: Record<string, ConfigRecord> = Object.create(null)
	for (const name of new Set([...Object.keys(base ?? {}), ...Object.keys(override ?? {})])) {
		plugins[name] = mergeConfigRecord(base?.[name], override?.[name])
	}
	return plugins
}

function mergeConfigRecord(
	base: Readonly<ConfigRecord> | undefined,
	override: Readonly<ConfigRecord> | undefined,
): ConfigRecord {
	const merged: ConfigRecord = Object.create(null)
	for (const [key, value] of Object.entries(base ?? {})) merged[key] = cloneConfigValue(value)
	for (const [key, value] of Object.entries(override ?? {})) {
		const current = merged[key]
		merged[key] =
			isPlainRecord(current) && isPlainRecord(value)
				? mergeConfigRecord(current, value)
				: cloneConfigValue(value)
	}
	return merged
}

function writeConfigPath(
	target: ConfigRecord,
	path: readonly string[],
	value: unknown,
	environmentName: string,
): void {
	let cursor = target
	for (let index = 0; index < path.length - 1; index += 1) {
		const segment = path[index]!
		const existing = cursor[segment]
		if (existing !== undefined && !isPlainRecord(existing)) {
			throw new Error(
				`[ConfigService] Conflicting plugin config environment paths at "${environmentName}"`,
			)
		}
		cursor = (cursor[segment] ??= Object.create(null)) as ConfigRecord
	}
	const leaf = path.at(-1)!
	if (cursor[leaf] !== undefined) {
		throw new Error(
			`[ConfigService] Duplicate plugin config environment path at "${environmentName}"`,
		)
	}
	cursor[leaf] = value
}

function decodeEnvironmentValue(value: string): unknown {
	try {
		return JSON.parse(value) as unknown
	} catch {
		return value
	}
}

function cloneConfigValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(cloneConfigValue)
	if (!isPlainRecord(value)) return value
	return mergeConfigRecord(undefined, value)
}

function isPlainRecord(value: unknown): value is ConfigRecord {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false
	const prototype = Object.getPrototypeOf(value)
	return prototype === Object.prototype || prototype === null
}
