import { perEnvironmentPlugin, type Plugin, type PluginOption } from 'vite'

type ViteEnvironment = Parameters<NonNullable<Plugin['applyToEnvironment']>>[0]

export function isServerConsumerEnvironment(environment: ViteEnvironment) {
	return environment.name === 'ssr' || environment.config.consumer === 'server'
}

export function isBrowserConsumerEnvironment(environment: ViteEnvironment) {
	return !isServerConsumerEnvironment(environment)
}

export function serverOnlyVitePlugin(name: string, plugin: PluginOption): Plugin {
	return perEnvironmentPlugin(name, (environment) =>
		isServerConsumerEnvironment(environment) ? plugin : false,
	)
}

export function browserOnlyVitePlugin(name: string, plugin: PluginOption): Plugin {
	return perEnvironmentPlugin(name, (environment) =>
		isBrowserConsumerEnvironment(environment) ? plugin : false,
	)
}
