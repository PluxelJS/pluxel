// packages/components/src/extension/types.ts

import type { ComponentType, ReactNode } from 'react'

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
 * 扩展点常量
 */
export const ExtensionPoints = {
	HeaderActions: 'header:actions',
	NavbarItems: 'navbar:items',
	NavbarFooter: 'navbar:footer',
	PluginTabs: 'plugin:tabs',
	PluginActions: 'plugin:actions',
	PluginInfo: 'plugin:info',
	GlobalStatusBar: 'global:statusBar',
} as const

/**
 * 扩展上下文 - 传递给所有扩展组件
 */
export interface ExtensionContext {
	/** 当前路由路径 */
	pathname: string
	/** 当前插件名（在插件详情页时） */
	pluginName?: string
	/** 插件是否运行中 */
	isPluginRunning?: boolean
	/** 当前运行中的插件集合 */
	runningPlugins?: ReadonlySet<string>
	/** 颜色模式 */
	colorScheme: 'light' | 'dark'
}

/**
 * 扩展元数据
 */
export interface ExtensionMeta {
	/** 唯一标识 */
	id: string
	/** 来源插件 */
	pluginName: string
	/** 优先级 */
	priority: number
	/** 是否需要插件运行 */
	requireRunning: boolean
	/** 额外数据 */
	[key: string]: unknown
}

/**
 * 扩展项
 */
export interface ExtensionItem {
	meta: ExtensionMeta
	render: (ctx: ExtensionContext) => ReactNode
	when?: (ctx: ExtensionContext) => boolean
}

/**
 * 路由扩展定义
 */
export interface RouteExtensionDef {
	/** 路由路径 */
	path: string
	/** 页面标题 */
	title: string
	/** 图标（可以是 Tabler Icons 名称或直接的 ReactNode） */
	icon?: string | ReactNode
	/** 是否添加到导航 */
	addToNav?: boolean
	/** 导航优先级 */
	navPriority?: number
}

/**
 * 插件 UI 模块格式（插件需要导出的格式）
 */
export interface PluginUIModule {
	/**
	 * 扩展点注册
	 */
	extensions?: Array<{
		point: ExtensionPoint
		meta?: Partial<ExtensionMeta>
		when?: (ctx: ExtensionContext) => boolean
		Component: ComponentType<{ ctx: ExtensionContext }>
	}>

	/**
	 * 路由扩展
	 */
	routes?: Array<{
		definition: RouteExtensionDef
		Component: ComponentType
	}>

	/**
	 * 模块初始化
	 */
	setup?: () => void | Promise<void>
}

/**
 * 编译后的扩展 bundle 信息（来自后端）
 */
export interface CompiledExtensionBundle {
	pluginName: string
	bundleUrl: string
	points: ExtensionPoint[]
	routes: string[]
	compiledAt: number
	sourceHash: string
}

/**
 * 扩展清单（来自后端 API）
 */
export interface ExtensionManifest {
	version: number
	bundles: CompiledExtensionBundle[]
}
