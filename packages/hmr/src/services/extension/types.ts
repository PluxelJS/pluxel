// packages/hmr/src/services/extension/types.ts

/**
 * 插件扩展注册配置
 * extensions 和 routes 在入口模块 (entryPath) 中通过 definePluginUIModule 定义
 */
export interface PluginExtensionConfig {
	/** 入口模块路径（如 ./ui/index.tsx） */
	entryPath: string
}

export interface CompiledExtensionModule {
	pluginName: string
	moduleUrl: string
	sourceHash: string
	compiledAt: number
}

export interface ExtensionManifest {
	version: number
	modules: CompiledExtensionModule[]
}

export type ExtensionManifestEvent =
	| {
			type: 'update'
			version: number
			pluginName: string
			sourceHash: string
			moduleUrl: string
			compiledAt: number
	  }
	| {
			type: 'remove'
			version: number
			pluginName: string
	  }
	| {
			type: 'sync'
			version: number
	  }
