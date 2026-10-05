import type { PluginOption } from 'vite'

export type HostViteProfile = 'development' | 'production'
export const PRODUCTION_SESSION_PLUGIN = 'pluxel:production-session'

/** The owning execution entry installs this marker; business configuration never selects a mode. */
export function hostViteProfile(plugins: readonly PluginOption[]): HostViteProfile {
	for (const plugin of plugins) {
		if (Array.isArray(plugin)) {
			if (hostViteProfile(plugin) === 'production') return 'production'
		} else if (
			plugin &&
			typeof plugin === 'object' &&
			'name' in plugin &&
			plugin.name === PRODUCTION_SESSION_PLUGIN
		)
			return 'production'
	}
	return 'development'
}
