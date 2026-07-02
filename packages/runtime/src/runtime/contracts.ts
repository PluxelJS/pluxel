import type { HttpServiceConfig } from '../services/http/HttpService'

export type FrozenHostBootstrap = {
	http?: Pick<HttpServiceConfig, 'management'>
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
	fs?: {
		mkdir(path: string, options?: { recursive?: boolean }): Promise<string | undefined>
		writeFile(path: string, data: string, encoding: BufferEncoding): Promise<void>
	}
}

export type BuildFrozenHostResult = {
	dir: string
	entry: string
	manifestPath: string
}
