import { createContext, createElement, type ReactNode, useContext } from 'react'

/**
 * Built-in extension point ids.
 *
 * These are the stable “host-known” points that plugins can target without any extra setup.
 * You can still add your own points by declaration-merging `ExtensionPointMap`.
 */
export const ExtensionPoints = {
	HeaderActions: 'header:actions',
	NavbarItems: 'navbar:items',
	NavbarFooter: 'navbar:footer',
	NavbarAuthText: 'navbar:authText',
	PluginTabs: 'plugin:tabs',
	PluginActions: 'plugin:actions',
	PluginInfo: 'plugin:info',
	GlobalStatusBar: 'global:statusBar',
} as const

/**
 * Global extension context.
 *
 * This is the `ctx` passed to extensions rendered in global areas (header/sidebar/status bar).
 *
 * Design notes:
 * - Global vs plugin contexts are different types, so extension components don’t need runtime guards.
 * - Plugin runtime state is modeled by `runningPlugins` + `runningPluginsReady` (avoid ambiguous flags).
 *
 * @example
 * function HeaderAction() {
 *   const ctx = useExtensionContext('global')
 *   const { hmr, i18n } = ctx.services
 *   return <button onClick={() => void hmr.withRpc((rpc) => rpc.ping())}>{i18n?.t('ping')}</button>
 * }
 *
 */
export interface GlobalExtensionContext {
	pathname: string
	colorScheme: 'light' | 'dark'
	runningPlugins: ReadonlySet<string>
	runningPluginsReady: boolean
	services: ExtensionServices
}

/**
 * Plugin-scoped extension context.
 *
 * This is the `ctx` passed to extensions rendered inside a plugin detail page (tabs/info/actions)
 * and to plugin route components.
 */
export interface PluginExtensionContext extends GlobalExtensionContext {
	pluginName: string
}

export type ExtensionContext = GlobalExtensionContext | PluginExtensionContext

/* ---------------------------- Extension Context IO ---------------------------- */

const ExtensionCtx = createContext<ExtensionContext | null>(null)

export interface ExtensionProviderProps {
	value: ExtensionContext
	children: ReactNode
}

/**
 * Provide `ExtensionContext` for route components.
 *
 * Most extensions receive `ctx` via props from the host. Route components, however, are rendered
 * by the host router and typically read the context via hooks.
 */
export function ExtensionProvider({ value, children }: ExtensionProviderProps) {
	return createElement(ExtensionCtx.Provider, { value }, children)
}

/**
 * Read the current `ExtensionContext`.
 *
 * Use this inside route components or deep trees where passing `ctx` props is inconvenient.
 * Throws when used outside an `ExtensionProvider`.
 */
export function useExtensionContext(): ExtensionContext
export function useExtensionContext(kind: 'global'): GlobalExtensionContext
export function useExtensionContext(kind: 'plugin'): PluginExtensionContext
export function useExtensionContext(kind?: 'global' | 'plugin'): ExtensionContext {
	const ctx = useContext(ExtensionCtx)
	if (!ctx) throw new Error('useExtensionContext must be used within ExtensionProvider')
	if (kind === 'plugin') {
		if (!('pluginName' in ctx))
			throw new Error('useExtensionContext("plugin") requires PluginExtensionContext')
		return ctx
	}
	if (kind === 'global') return 'pluginName' in ctx ? toGlobalExtensionContext(ctx) : ctx
	return ctx
}

/**
 * Extension point contract map.
 *
 * - 这是外部可扩展的“协议表”：用户可通过 declaration merging 添加自定义 point。
 * - 每个 point 指定自己的 ctx 类型与 meta 结构；类型将自动推导到 render/meta。
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
	/**
	 * Sidebar 登录状态文本（支持多用户场景：显示当前用户、审计信息入口等）。
	 * - 宿主不会强制格式；插件可返回任意 ReactNode。
	 */
	'navbar:authText': { ctx: GlobalExtensionContext; meta: {}; metaRequired?: false }
	'plugin:tabs': {
		ctx: PluginExtensionContext
		meta: {
			/**
			 * Default tab label when `meta.tab` is not specified.
			 * For grouped tabs, this label can be treated as the item label within the tab.
			 */
			label: string
			icon?: string | ReactNode
			/**
			 * Optional grouping: multiple extensions can render into the same host tab,
			 * enabling mixed layouts (stacked cards/controls in one tab).
			 */
			tab?: { id: string; label: string; icon?: string | ReactNode }
		}
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

/* ----------------------------------- i18n ----------------------------------- */

export type I18nLocale = string
export type I18nKey = string
export type I18nParams = Record<string, string | number | boolean | null | undefined | Date>
export type I18nMessageDict = Record<I18nKey, string>
export type I18nResources = Record<I18nLocale, I18nMessageDict>

/**
 * Host-provided i18n service for plugin UI bundles.
 *
 * Goals:
 * - Keep UI bundles small (don’t ship a full i18n runtime per plugin).
 * - Use the host’s locale and formatting rules.
 *
 * Notes:
 * - Keys are plain strings. Hosts may choose to namespace keys (recommended).
 * - `t()` supports `{param}` interpolation.
 */
export interface I18nService {
	/** Current UI locale (BCP-47, e.g. `en`, `zh-CN`). */
	locale: I18nLocale
	/** Optional fallback locale (e.g. `en`). */
	fallbackLocale?: I18nLocale
	/**
	 * Translate a key with optional `{param}` interpolation.
	 * - When missing, returns `options.defaultValue ?? key`.
	 */
	t: (key: I18nKey, params?: I18nParams, options?: { defaultValue?: string }) => string
	has: (key: I18nKey, locale?: I18nLocale) => boolean
	formatDate: (value: Date | number, options?: Intl.DateTimeFormatOptions) => string
	formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string
}

/**
 * Create a minimal i18n service (host-side convenience).
 *
 * This is intentionally small and dependency-free; hosts can replace it with a more
 * powerful implementation while keeping the same interface surface for plugins.
 */
export function createI18nService(input: {
	locale: I18nLocale
	resources?: I18nResources
	fallbackLocale?: I18nLocale
	defaultValue?: (key: I18nKey) => string
}): I18nService {
	const resources = input.resources ?? {}
	const locale = input.locale
	const fallbackLocale = input.fallbackLocale
	const defaultValue = input.defaultValue

	const dateCache = new Map<string, Intl.DateTimeFormat>()
	const numberCache = new Map<string, Intl.NumberFormat>()

	const getDateFormatter = (opts?: Intl.DateTimeFormatOptions) => {
		const key = `${locale}::${opts ? safeJsonKey(opts) : ''}`
		const cached = dateCache.get(key)
		if (cached) return cached
		try {
			const fmt = new Intl.DateTimeFormat(locale, opts)
			dateCache.set(key, fmt)
			return fmt
		} catch {
			return null
		}
	}

	const getNumberFormatter = (opts?: Intl.NumberFormatOptions) => {
		const key = `${locale}::${opts ? safeJsonKey(opts) : ''}`
		const cached = numberCache.get(key)
		if (cached) return cached
		try {
			const fmt = new Intl.NumberFormat(locale, opts)
			numberCache.set(key, fmt)
			return fmt
		} catch {
			return null
		}
	}

	const formatDate: I18nService['formatDate'] = (value, opts) => {
		const date = typeof value === 'number' ? new Date(value) : value
		const fmt = getDateFormatter(opts)
		if (!fmt) return date.toISOString()
		try {
			return fmt.format(date)
		} catch {
			return date.toISOString()
		}
	}

	const formatNumber: I18nService['formatNumber'] = (value, opts) => {
		const fmt = getNumberFormatter(opts)
		if (!fmt) return String(value)
		try {
			return fmt.format(value)
		} catch {
			return String(value)
		}
	}

	const lookup = (key: I18nKey): string | undefined => {
		const primary = resources?.[locale]?.[key]
		if (typeof primary === 'string') return primary
		if (fallbackLocale) {
			const fb = resources?.[fallbackLocale]?.[key]
			if (typeof fb === 'string') return fb
		}
		return undefined
	}

	const has: I18nService['has'] = (key, loc) => {
		const useLocale = loc ?? locale
		return typeof resources?.[useLocale]?.[key] === 'string'
	}

	const t: I18nService['t'] = (key, params, options) => {
		const template = lookup(key) ?? options?.defaultValue ?? defaultValue?.(key) ?? key
		if (!params) return template
		return template.replace(/\{([a-zA-Z0-9_.-]+)\}/g, (_m, rawName) => {
			const name = String(rawName)
			const value = (params as any)[name] as unknown
			if (value === undefined || value === null) return ''
			if (value instanceof Date) return formatDate(value)
			if (typeof value === 'number') return String(value)
			if (typeof value === 'boolean') return value ? 'true' : 'false'
			return String(value)
		})
	}

	return { locale, fallbackLocale, t, has, formatDate, formatNumber }
}

function safeJsonKey(value: unknown): string {
	try {
		return JSON.stringify(value) ?? ''
	} catch {
		return ''
	}
}

export interface PluginI18nBundle {
	/**
	 * Namespace used by the host to avoid key collisions.
	 * - Default (recommended): pluginName.
	 */
	namespace?: string
	/** Translation resources keyed by locale. */
	resources: I18nResources
}

/**
 * Extension service bag.
 *
 * - 用于在 ctx 中注入宿主能力（RPC/SSE/导航等）
 * - 通过 declaration merging 扩展，避免 ctx 顶层不断膨胀
 *
 * @example
 * // Host app or integration package:
 * declare module '@pluxel/hmr-web' {
 *   interface ExtensionServices {
 *     myService: { hello: () => void }
 *   }
 * }
 */
export interface ExtensionServices {
	/**
	 * Optional host UI primitives (confirm dialogs, notifications, etc).
	 * Hosts may omit these; builtins should gracefully fallback when unavailable.
	 */
	ui?: {
		notify?: (payload: UiNotifyPayload) => void
		confirm?: (payload: UiConfirmPayload) => Promise<boolean>
	}
	/**
	 * Optional i18n service provided by the host.
	 *
	 * Plugin UI should prefer this over bundling their own i18n runtime to keep
	 * UI bundles small and consistent with host locale settings.
	 */
	i18n?: I18nService
}

/**
 * Build a `GlobalExtensionContext` (host-side).
 *
 * Plugin code usually does not call this directly.
 */
export function createGlobalExtensionContext(input: {
	pathname: string
	colorScheme: 'light' | 'dark'
	runningPlugins: ReadonlySet<string>
	runningPluginsReady: boolean
	services: ExtensionServices
}): GlobalExtensionContext {
	return {
		...input,
		services: input.services,
	}
}

/**
 * Convert a `GlobalExtensionContext` into a plugin-scoped one.
 *
 * Hosts typically call this when rendering plugin detail pages and plugin routes.
 */
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
	/**
	 * Extension renderer.
	 *
	 * Renderer receives the typed ctx; using hooks is optional.
	 */
	render: (ctx: ExtensionPointCtx<P>) => ReactNode
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
		render: (ctx: PluginExtensionContext) => ReactNode
	}>
	/**
	 * Optional i18n resources shipped with the UI module.
	 * The host may merge these into its own i18n service.
	 */
	i18n?: PluginI18nBundle | PluginI18nBundle[]
	/**
	 * Optional lifecycle hook called after the UI module is loaded.
	 * Return a cleanup function to run when unloaded (e.g. remove subscriptions).
	 */
	setup?: (ctx: { pluginName: string }) => void | (() => void) | Promise<void | (() => void)>
}

/**
 * Define a plugin UI module with validation in dev.
 *
 * Recommended: default-export the result.
 *
 * @example
 * export default definePluginUIModule({
 *   extensions: [{ point: 'header:actions', id: 'hello', render: (ctx) => <Hello ctx={ctx} /> }],
 * })
 */
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
			if (typeof (ext as any)?.render !== 'function') {
				console.error('[plugin-ui] Extension render must be a function.', ext)
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
			if (typeof (route as any)?.render !== 'function') {
				console.error('[plugin-ui] Route render must be a function.', route)
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

/**
 * Host UI interaction services (optional).
 *
 * These are injected by the host application, and are meant to be stable across
 * frontend implementations (no direct dependency on a specific UI library).
 */
export type UiNotifyTone = 'info' | 'success' | 'warning' | 'error'

export interface UiNotifyPayload {
	title?: string
	message?: string
	tone?: UiNotifyTone
}

export type UiConfirmTone = 'default' | 'danger'

export interface UiConfirmPayload {
	title?: string
	message: string
	confirmLabel?: string
	cancelLabel?: string
	tone?: UiConfirmTone
}

/**
 * Built-in / host-rendered UI extensions (no plugin module import needed).
 *
 * These are intentionally JSON-serializable so plugins can contribute UI without shipping
 * browser-side code (e.g. simple info cards powered by RPC results).
 */
export type BuiltinExtensionKind = 'doc'

type BuiltinMetaProp<P extends ExtensionPoint> = ExtensionPointMap[P] extends { metaRequired: true }
	? { meta: ExtensionPointMeta<P> }
	: { meta?: ExtensionPointMeta<P> }

export type BuiltinExtensionBase<P extends ExtensionPoint = ExtensionPoint> = BuiltinMetaProp<P> & {
	kind: BuiltinExtensionKind
	/** Extension point to mount into */
	point: P
	/** Stable id within the plugin (used to build a runtime-global id) */
	id: string
	/** Owning plugin name */
	pluginName: string
	priority?: number
	requireRunning?: boolean
}

export type BuiltinSseRef<T = unknown> = {
	/** Live value resolved from SSE payload */
	kind: 'sse'
	/** SSE event name (defaults to `state`) */
	event?: string
	/**
	 * Dot-path to pick from payload (e.g. `stats.uptimeMs`).
	 * When omitted, uses the whole payload.
	 */
	path?: string
	/** Used when path is missing / payload absent */
	fallback?: T
}

export type BuiltinBadgeValue = {
	kind: 'badge'
	label: string
	color?: string
	variant?: 'filled' | 'light' | 'outline' | 'dot'
	size?: 'xs' | 'sm' | 'md' | 'lg'
	radius?: 'xs' | 'sm' | 'md' | 'lg' | 'xl'
}

export type BuiltinValue =
	| string
	| number
	| boolean
	| null
	| BuiltinBadgeValue
	| { kind: 'json'; value: unknown }
	| BuiltinSseRef

export type BuiltinInfoCardRow = {
	label: string
	value: BuiltinValue
	/**
	 * Optional layout hint for grid mode.
	 * - When omitted, the host may auto-span for wide values (JSON).
	 */
	span?: number
}

export type BuiltinInfoCardLayout = {
	/**
	 * `list`: label left, value right (default).
	 * `grid`: multi-column, label on top by default.
	 */
	variant?: 'list' | 'grid'
	/** Visual density (smaller paddings/gaps). */
	density?: 'comfortable' | 'compact'
	/** Number of columns when `variant='grid'`. */
	columns?: 1 | 2 | 3 | 4
	/** Label placement inside each item (grid only). */
	labelPlacement?: 'top' | 'left'
	/** Value alignment for list mode. */
	valueAlign?: 'left' | 'right'
}

export type BuiltinDocBlockKind = 'infoCard' | 'rpcAutoForm'

export type BuiltinInfoCardBlock = {
	kind: 'infoCard'
	title?: string
	description?: string
	rows?: BuiltinInfoCardRow[]
	layout?: BuiltinInfoCardLayout
}

export type BuiltinRpcAutoFormBlock = {
	kind: 'rpcAutoForm'
	title?: string
	description?: string
	submitLabel?: string
	/**
	 * Submission strategy.
	 * - manual: show actions and require explicit submit (default)
	 * - onChange: auto-submit when form values change (useful for toggles/sliders)
	 */
	submitMode?: 'manual' | 'onChange'
	/** Debounce auto-submit for onChange mode. Defaults to 250ms. */
	autoSubmitDebounceMs?: number
	/**
	 * Optional SSE source to keep the form values in sync with runtime state.
	 * - Recommended for `submitMode='onChange'` so toggles reflect true runtime state.
	 * - Only keys that exist in the schema defaults will be applied.
	 */
	syncFromSse?: BuiltinSseRef<Record<string, unknown>>
	/**
	 * Hold duration (ms) after a successful onChange submit to ignore mismatched SSE payloads.
	 * Helps prevent flicker when SSE lags behind local updates.
	 */
	syncHoldMs?: number
	/**
	 * Reference a plugin's existing `@Config` schema key (schemaSourceMap key).
	 * The host will fetch/compile the schema and render an AutoForm.
	 */
	schemaKey: string
	/**
	 * RPC call to execute on submit.
	 * - Default: pass the whole form value as the first arg.
	 * - Use args template to customize, and `{ kind:'field', key }` to pick a field value.
	 */
	rpc: { method: string; args?: BuiltinRpcArg[] }
	confirm?: UiConfirmPayload
	feedback?: {
		success?: UiNotifyPayload
		error?: UiNotifyPayload
	}
	resetOnSuccess?: boolean
}

export type BuiltinDocBlock = BuiltinInfoCardBlock | BuiltinRpcAutoFormBlock

export type BuiltinDocExtensionDef<P extends ExtensionPoint = ExtensionPoint> =
	BuiltinExtensionBase<P> & {
		kind: 'doc'
		title?: string
		description?: string
		/** Markdown content with `::block[blockId]` placeholders. */
		content?: string
		/** Builtin blocks referenced by `::block[...]`. */
		blocks?: Record<string, BuiltinDocBlock>
		/** Ordering used when `content` is omitted. */
		blockOrder?: string[]
	}

export type BuiltinRpcArg = unknown | { kind: 'field'; key: string }

export const defineDocBlocks = <T extends Record<string, BuiltinDocBlock>>(blocks: T): T => blocks

export function md(strings: TemplateStringsArray, ...values: Array<string | number>): string {
	let out = ''
	for (let i = 0; i < strings.length; i++) {
		out += strings[i] ?? ''
		if (i < values.length) out += String(values[i])
	}
	const lines = out.replace(/\r\n/g, '\n').split('\n')
	while (lines.length && lines[0].trim() === '') lines.shift()
	while (lines.length && lines[lines.length - 1].trim() === '') lines.pop()
	let minIndent = Number.POSITIVE_INFINITY
	for (const line of lines) {
		if (!line.trim()) continue
		const match = line.match(/^[\t ]+/)
		const indent = match ? match[0].length : 0
		minIndent = Math.min(minIndent, indent)
	}
	if (!Number.isFinite(minIndent) || minIndent <= 0) return lines.join('\n')
	return lines.map((line) => (line.trim() ? line.slice(minIndent) : '')).join('\n')
}

export function blockRef<T extends Record<string, BuiltinDocBlock>>(
	_blocks: T,
	key: keyof T,
): string {
	return `::block[${String(key)}]`
}

export type BuiltinExtensionDef = BuiltinDocExtensionDef

export interface CompiledExtensionModule {
	pluginName: string
	moduleUrl: string
	sourceHash: string
	compiledAt: number
}

export interface ExtensionManifest {
	version: number
	modules: CompiledExtensionModule[]
	builtins?: BuiltinExtensionDef[]
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
