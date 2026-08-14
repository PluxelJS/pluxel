import { makeIdFiltersToMatchWithQuery } from '@rolldown/pluginutils'
import { perEnvironmentPlugin, type Plugin, type PluginOption } from 'vite'

type ViteEnvironment = Parameters<NonNullable<Plugin['applyToEnvironment']>>[0]

export function isServerConsumerEnvironment(environment: ViteEnvironment): boolean {
	return environment.name === 'ssr' || environment.config.consumer === 'server'
}

export function isBrowserConsumerEnvironment(environment: ViteEnvironment): boolean {
	return !isServerConsumerEnvironment(environment)
}

export function serverOnlyVitePlugin(
	name: string,
	plugin: PluginOption,
	options: { enforce?: 'pre' | 'post' } = {},
): Plugin {
	const wrapped = perEnvironmentPlugin(name, (environment) =>
		isServerConsumerEnvironment(environment) ? plugin : false,
	)
	return options.enforce ? { ...wrapped, enforce: options.enforce } : wrapped
}

export function browserOnlyVitePlugin(name: string, plugin: PluginOption): Plugin {
	return perEnvironmentPlugin(name, (environment) =>
		isBrowserConsumerEnvironment(environment) ? plugin : false,
	)
}

export function matchViteIdsWithQuery(patterns: string[]): string[] {
	return makeIdFiltersToMatchWithQuery(patterns)
}
