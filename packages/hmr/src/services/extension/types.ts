// packages/hmr/src/services/extension/types.ts

/**
 * 扩展点位置
 */
export type ExtensionPoint =
	| 'header:actions' // Header 右侧操作区
	| 'navbar:items' // 导航栏项目
	| 'navbar:footer' // 导航栏底部
	| 'plugin:tabs' // 插件详情 Tab
	| 'plugin:actions' // 插件操作按钮
	| 'plugin:info' // 插件信息卡片
	| 'global:statusBar' // 全局状态栏

/**
 * 扩展条件
 */
export interface ExtensionCondition {
	/** 仅当路由匹配时显示 */
	pathMatch?: string | RegExp
	/** 仅当指定插件时显示 */
	pluginName?: string
	/** 自定义表达式 */
	expression?: string
}

/**
 * UI 组件扩展
 */
export interface UIExtension {
	/** 扩展点 */
	point: ExtensionPoint
	/** 组件模块路径（相对于插件目录） */
	componentPath: string
	/** 优先级（越大越靠前） */
	priority?: number
	/** 是否需要插件运行中 */
	requireRunning?: boolean
	/** 显示条件 */
	when?: ExtensionCondition
	/** 额外 props */
	props?: Record<string, unknown>
	/** 元数据（如 Tab label） */
	meta?: Record<string, unknown>
}

/**
 * 路由扩展
 */
export interface RouteExtension {
	/** 路由路径（相对于 /ext/{pluginName}） */
	path: string
	/** 页面组件路径 */
	componentPath: string
	/** 页面标题 */
	title: string
	/** 图标名称 */
	icon?: string
	/** 是否添加到导航 */
	addToNav?: boolean
	/** 导航优先级 */
	navPriority?: number
}

/**
 * 插件扩展注册
 */
export interface PluginExtensionConfig {
	/** 插件名 */
	pluginName: string
	/** UI 组件扩展 */
	ui?: UIExtension[]
	/** 路由扩展 */
	routes?: RouteExtension[]
	/** 入口模块路径（如 ./ui/index.tsx） */
	entryPath?: string
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
