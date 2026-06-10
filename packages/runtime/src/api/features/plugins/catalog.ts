import type { Context as PlxContext, PluginConstructor } from '@pluxel/core'

export type RuntimePluginSource =
	| {
			__typename: 'PluginSourceInfo'
			kind: 'package'
			moduleId: string
			packageName: string
			version: string | null
			tag: string | null
	  }
	| {
			__typename: 'PluginSourceInfo'
			kind: 'hmr'
			moduleId: string
			packageName: null
			version: null
			tag: null
	  }
	| {
			__typename: 'PluginSourceInfo'
			kind: 'unknown'
			moduleId: null
			packageName: null
			version: null
			tag: null
	  }

export type RuntimePluginStatusSnapshot = {
	isRunning: boolean
	isEnabled: boolean
	lifecycleStage: 'running' | 'stopped' | 'disabled'
	source: RuntimePluginSource
}

export type RuntimePluginStatusOverview = {
	statuses: Array<RuntimePluginStatusSnapshot & { name: string }>
	summary: {
		total: number
		running: number
		stopped: number
		disabled: number
	}
}

export type RuntimePluginDependencyInfo = Array<{ name: string; isRunning: boolean }>

export type PluginCatalogApi = {
	require(name: string): PluginConstructor
	resolve(target: PluginConstructor | string): PluginConstructor | undefined
	listDependencies(ctor: PluginConstructor): RuntimePluginDependencyInfo
	resolveSource(name: string, ctor?: PluginConstructor): RuntimePluginSource
	readStatus(name: string, ctor: PluginConstructor): RuntimePluginStatusSnapshot
	statusOverview(): RuntimePluginStatusOverview
}

export function runtimePluginCatalog(ctx: PlxContext): PluginCatalogApi {
	return (ctx as PlxContext & { pluginCatalog: PluginCatalogApi }).pluginCatalog
}
