import { browserOnlyVitePlugin, serverOnlyVitePlugin } from '../src/vite'
import { fixRolldownUndefinedExportsPlugin } from '@pluxel/workspace/vite'
import type { Plugin, PluginOption } from 'vite'

export function serverOnlyPlugin(plugin: Plugin): Plugin {
	return serverOnlyVitePlugin(`${plugin.name}:server-only`, plugin)
}

export function browserOnlyPlugin(plugin: Plugin): Plugin {
	return browserOnlyVitePlugin(`${plugin.name}:browser-only`, plugin)
}

export function createRuntimeWebPlugins(): PluginOption[] {
	return [fixRolldownUndefinedExportsPlugin()]
}
