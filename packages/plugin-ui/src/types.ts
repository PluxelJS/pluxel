import type { ComponentType, ReactNode } from 'react'

/**
 * 扩展点位置
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
 *
 * 设计原则：
 * - 全局扩展与插件扩展使用不同 ctx 类型，组件无需写 kind guard
 * - 插件运行态由 runningPlugins 决定；不引入 isPluginRunning 这种易混淆字段
 */
export interface GlobalExtensionContext {
	pathname: string
	colorScheme: 'light' | 'dark'
	runningPlugins: ReadonlySet<string>
	runningPluginsReady: boolean
	services: ExtensionServices
}

export interface PluginExtensionContext extends GlobalExtensionContext {
	pluginName: string
}

export type ExtensionContext = GlobalExtensionContext | PluginExtensionContext

/**
 * Extension point contract map.
 *
 * - 这是外部可扩展的“协议表”：用户可通过 declaration merging 添加自定义 point。
 * - 每个 point 指定自己的 ctx 类型与 meta 结构；类型将自动推导到 Component/when/meta。
 */
export interface ExtensionPointMap {
	'header:actions': { ctx: GlobalExtensionContext; meta: {}; metaRequired?: false }
	'navbar:items': {
		ctx: GlobalExtensionContext
		meta: {
			label: string
			href: string
			icon?: string | ReactNode
			rightSection?: ReactNode
			exact?: boolean
		}
		metaRequired: true
	}
	'navbar:footer': {
		ctx: GlobalExtensionContext
		meta: {
			label?: string
			href?: string
			icon?: string | ReactNode
		}
		metaRequired?: false
	}
	'plugin:tabs': {
		ctx: PluginExtensionContext
		meta: { label: string; icon?: string | ReactNode }
		metaRequired: true
	}
	'plugin:actions': {
		ctx: PluginExtensionContext
		meta: { label?: string; icon?: string | ReactNode }
		metaRequired?: false
	}
	'plugin:info': { ctx: PluginExtensionContext; meta: {}; metaRequired?: false }
	'global:statusBar': {
		ctx: GlobalExtensionContext
		meta: { label?: string }
		metaRequired?: false
	}
}

export type ExtensionPoint = keyof ExtensionPointMap & string
export type ExtensionPointCtx<P extends ExtensionPoint> = ExtensionPointMap[P]['ctx']
export type ExtensionPointMeta<P extends ExtensionPoint> = ExtensionPointMap[P]['meta']

/**
 * Extension service bag.
 *
 * - 用于在 ctx 中注入宿主能力（RPC/SSE/导航等）
 * - 通过 declaration merging 扩展，避免 ctx 顶层不断膨胀
 */
// biome-ignore lint/suspicious/noEmptyInterface: 外部扩展
export interface ExtensionServices {}

export function createGlobalExtensionContext(input: {
	pathname: string
	colorScheme: 'light' | 'dark'
	runningPlugins: ReadonlySet<string>
	runningPluginsReady: boolean
	services?: ExtensionServices
}): GlobalExtensionContext {
	return {
		...input,
		services: input.services ?? {},
	}
}

export function createPluginExtensionContext(
	base: GlobalExtensionContext,
	input: { pluginName: string; pathname?: string },
): PluginExtensionContext {
	return {
		...base,
		pathname: input.pathname ?? base.pathname,
		pluginName: input.pluginName,
	}
}

export function isExtensionPluginRunning(ctx: ExtensionContext, pluginName: string): boolean {
	return ctx.runningPlugins.has(pluginName)
}

export function toGlobalExtensionContext(ctx: ExtensionContext): GlobalExtensionContext {
	if (!('pluginName' in ctx)) return ctx
	const { pluginName: _pluginName, ...rest } = ctx
	return rest
}

/**
 * 扩展元数据
 */
export interface RuntimeMetaBase {
	id: string
	pluginName: string
	priority: number
	requireRunning: boolean
}

export type ExtensionMeta<P extends ExtensionPoint = ExtensionPoint> = RuntimeMetaBase &
	ExtensionPointMeta<P>

export interface ExtensionItem<P extends ExtensionPoint = ExtensionPoint> {
	meta: ExtensionMeta<P>
	render: (ctx: ExtensionPointCtx<P>) => ReactNode
	when?: (ctx: ExtensionPointCtx<P>) => boolean
}

export interface RouteExtensionDef {
	path: string
	title: string
	icon?: string | ReactNode
	addToNav?: boolean
	navPriority?: number
}

/**
 * 插件 UI 模块格式（插件需要导出的格式）
 */
type MetaProp<P extends ExtensionPoint> = ExtensionPointMap[P] extends { metaRequired: true }
	? { meta: ExtensionPointMeta<P> }
	: { meta?: ExtensionPointMeta<P> }

export type ExtensionDef<P extends ExtensionPoint = ExtensionPoint> = {
	point: P
	/**
	 * 扩展在插件内的稳定 ID（无需包含 pluginName 前缀；运行时会自动加上）。
	 *
	 * 设计目标：
	 * - 作为 React key / registry key，必须稳定且唯一（在同一 plugin module 内）。
	 * - 避免依赖 index / Math.random 这类不稳定生成逻辑。
	 */
	id: string
	/** 扩展优先级（越大越靠前） */
	priority?: number
	/** 如果为 true，则要求对应插件处于 running 状态才展示 */
	requireRunning?: boolean
	when?: (ctx: ExtensionPointCtx<P>) => boolean
	Component: ComponentType<{ ctx: ExtensionPointCtx<P> }>
} & MetaProp<P>

/**
 * Union of all concrete ExtensionDef variants.
 *
 * This preserves the relationship between `point` and `ctx` so TS can infer:
 * - point: 'plugin:tabs'  -> ctx: PluginExtensionContext
 * - point: 'header:actions' -> ctx: GlobalExtensionContext
 */
export type AnyExtensionDef = { [P in ExtensionPoint]: ExtensionDef<P> }[ExtensionPoint]

export interface PluginUIModule {
	extensions?: AnyExtensionDef[]
	routes?: Array<{
		definition: RouteExtensionDef
		Component: ComponentType
	}>
	setup?: (ctx: { pluginName: string }) => void | (() => void) | Promise<void | (() => void)>
}

export function definePluginUIModule<T extends PluginUIModule>(module: T): T {
	if (isDevEnvironment()) {
		validatePluginUIModule(module)
	}
	return module
}

function isDevEnvironment(): boolean {
	// Prefer Vite-style env when available
	try {
		const metaEnv = (import.meta as any)?.env
		if (metaEnv && typeof metaEnv === 'object') {
			if (typeof metaEnv.PROD === 'boolean') return !metaEnv.PROD
			if (typeof metaEnv.DEV === 'boolean') return metaEnv.DEV
			if (typeof metaEnv.MODE === 'string') return metaEnv.MODE !== 'production'
		}
	} catch {}

	// Node-style env without referencing `process` identifier (browser-safe)
	try {
		const p = (globalThis as any)?.process
		const nodeEnv = p?.env?.NODE_ENV
		if (typeof nodeEnv === 'string') return nodeEnv !== 'production'
	} catch {}

	return false
}

function validatePluginUIModule(module: PluginUIModule): void {
	if (!module || typeof module !== 'object') return

	// 1) extension ids must be stable and unique (within a module)
	if (Array.isArray(module.extensions)) {
		const seen = new Set<string>()
		for (const ext of module.extensions) {
			const id = (ext as any)?.id
			if (typeof id !== 'string' || id.trim().length === 0) {
				console.error('[plugin-ui] Extension id must be a non-empty string.', ext)
				continue
			}
			if (seen.has(id)) {
				console.error(
					'[plugin-ui] Duplicate extension id detected (must be unique per module).',
					id,
					ext,
				)
			}
			seen.add(id)
		}
	}

	// 2) route paths must be unique (normalized)
	if (Array.isArray(module.routes)) {
		const seen = new Set<string>()
		for (const route of module.routes) {
			const raw = route?.definition?.path
			const path = normalizeRoutePath(typeof raw === 'string' ? raw : '')
			if (!path) {
				console.error('[plugin-ui] Route path must be a non-empty string.', route)
				continue
			}
			if (seen.has(path)) {
				console.error(
					'[plugin-ui] Duplicate route path detected (must be unique per module).',
					path,
					route,
				)
			}
			seen.add(path)
		}
	}
}

function normalizeRoutePath(path: string): string {
	const trimmed = path.trim()
	if (!trimmed || trimmed === '/') return '/'
	const segments = trimmed
		.split('/')
		.map((segment) => segment.trim())
		.filter((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
	return `/${segments.join('/')}`
}

/**
 * 插件扩展注册配置（服务端）
 */
export interface PluginExtensionConfig {
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
