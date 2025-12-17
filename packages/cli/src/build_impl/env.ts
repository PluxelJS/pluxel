const ENV_PLUGIN_PREFIX = 'PLUXEL_PLUGIN_PREFIX'
const ENV_MANIFEST_FIELD = 'PLUXEL_MANIFEST_FIELD'

const DEFAULT_PLUGIN_PREFIXES = ['pluxel-plugin']
const DEFAULT_MANIFEST_FIELD = 'pluxel'
export const MANIFEST_DEPEND_ON_FIELD = 'dependOn'

export interface PluginEnvConfig {
	pluginPrefixes: string[]
	manifestField: string
}

export const BuildEnvKeys = {
	pluginPrefix: ENV_PLUGIN_PREFIX,
	manifestField: ENV_MANIFEST_FIELD,
} as const

export function resolvePluginEnv(): PluginEnvConfig {
	return {
		pluginPrefixes: readList(process.env[ENV_PLUGIN_PREFIX], DEFAULT_PLUGIN_PREFIXES),
		manifestField: readText(process.env[ENV_MANIFEST_FIELD], DEFAULT_MANIFEST_FIELD),
	}
}

function readList(input: string | undefined, fallback: string[]) {
	if (!input || !input.trim()) return [...fallback]
	return input
		.split(',')
		.map((segment) => segment.trim())
		.filter(Boolean)
}

function readText(input: string | undefined, fallback: string) {
	return input && input.trim() ? input.trim() : fallback
}
