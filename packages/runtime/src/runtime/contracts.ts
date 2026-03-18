import type { HttpServiceConfig, UiAssetStrategy } from '../services/http/HttpService'

export type HostControlPlane = NonNullable<HttpServiceConfig['controlPlane']>
export type UiAssetStrategySpec = UiAssetStrategy

export type FrozenHostBootstrap = {
	controlPlane?: HostControlPlane
	uiAssets?: UiAssetStrategySpec
}

export type PluginModuleRef = {
	moduleId: string
	importPath: string
	exportKey: string
	source: 'workspace-source' | 'workspace-dist' | 'installed-dist' | 'generated'
	packageName?: string
}

export type FrozenPluginSpec = PluginModuleRef & {
	enable?: boolean
}

export type BuildFrozenHostOptions = {
	outDir: string
	plugins: readonly FrozenPluginSpec[]
	config?: Record<string, Record<string, unknown>>
	enabled?: readonly string[]
	profile?: string
	generatedBy?: string
	bootstrap?: FrozenHostBootstrap
}

export type BuildFrozenHostResult = {
	dir: string
	entry: string
	manifestPath: string
}
