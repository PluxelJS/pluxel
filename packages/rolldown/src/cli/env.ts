const ENV_MANIFEST_FIELD = 'PLUXEL_MANIFEST_FIELD'

const DEFAULT_MANIFEST_FIELD = 'pluxel'
export const MANIFEST_PLUGIN_PACKAGES_FIELD = 'pluginPackages'

export interface PluginEnvConfig {
	manifestField: string
}

export const BuildEnvKeys = {
	manifestField: ENV_MANIFEST_FIELD,
} as const

export function resolvePluginEnv(): PluginEnvConfig {
	return {
		manifestField: readText(process.env[ENV_MANIFEST_FIELD], DEFAULT_MANIFEST_FIELD),
	}
}

function readText(input: string | undefined, fallback: string) {
	return input && input.trim() ? input.trim() : fallback
}
