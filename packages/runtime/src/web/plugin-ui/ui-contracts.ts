import { createContext, createElement, type ReactNode, useContext } from 'react'
import type { HmrWebClient } from './ui-runtime'

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

export interface GlobalExtensionContext {
	colorScheme: 'light' | 'dark'
	runningPlugins: ReadonlySet<string>
	runningPluginsReady: boolean
	services: ExtensionServices
}

export interface PluginExtensionContext extends GlobalExtensionContext {
	pluginName: string
	pathname: string
}

export type ExtensionContext = GlobalExtensionContext | PluginExtensionContext

const ExtensionCtx = createContext<ExtensionContext | null>(null)
const ExtensionPathnameCtx = createContext<string | null>(null)

export interface ExtensionProviderProps {
	value: ExtensionContext
	children: ReactNode
}

export function ExtensionProvider({ value, children }: ExtensionProviderProps) {
	return createElement(ExtensionCtx.Provider, { value }, children)
}

export interface ExtensionPathnameProviderProps {
	value: string
	children: ReactNode
}

export function ExtensionPathnameProvider({ value, children }: ExtensionPathnameProviderProps) {
	return createElement(ExtensionPathnameCtx.Provider, { value }, children)
}

export function useExtensionContext(): ExtensionContext
export function useExtensionContext(kind: 'global'): GlobalExtensionContext
export function useExtensionContext(kind: 'plugin'): PluginExtensionContext
export function useExtensionContext(kind?: 'global' | 'plugin'): ExtensionContext {
	const ctx = useContext(ExtensionCtx)
	if (!ctx) throw new Error('useExtensionContext must be used within ExtensionProvider')
	if (kind === 'plugin') {
		if (!('pluginName' in ctx)) {
			throw new Error('useExtensionContext("plugin") requires PluginExtensionContext')
		}
		return ctx
	}
	if (kind === 'global') return 'pluginName' in ctx ? toGlobalExtensionContext(ctx) : ctx
	return ctx
}

export function useExtensionPathname(): string {
	const pluginCtx = useContext(ExtensionCtx)
	if (pluginCtx && 'pluginName' in pluginCtx) return pluginCtx.pathname
	const pathname = useContext(ExtensionPathnameCtx)
	if (typeof pathname === 'string') return pathname
	throw new Error('useExtensionPathname must be used within ExtensionPathnameProvider')
}

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
	'navbar:authText': { ctx: GlobalExtensionContext; meta: {}; metaRequired?: false }
	'plugin:tabs': {
		ctx: PluginExtensionContext
		meta: {
			label: string
			icon?: string | ReactNode
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

export type I18nLocale = string
export type I18nKey = string
export type I18nParams = Record<string, string | number | boolean | null | undefined | Date>
export type I18nMessageDict = Record<I18nKey, string>
export type I18nResources = Record<I18nLocale, I18nMessageDict>

export interface I18nService {
	locale: I18nLocale
	fallbackLocale?: I18nLocale
	t: (key: I18nKey, params?: I18nParams, options?: { defaultValue?: string }) => string
	has: (key: I18nKey, locale?: I18nLocale) => boolean
	formatDate: (value: Date | number, options?: Intl.DateTimeFormatOptions) => string
	formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string
}

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
	namespace?: string
	resources: I18nResources
}

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

export interface ExtensionServices {
	hmr: HmrWebClient
	ui?: {
		notify?: (payload: UiNotifyPayload) => void
		confirm?: (payload: UiConfirmPayload) => Promise<boolean>
	}
	i18n?: I18nService
}

export function createGlobalExtensionContext(input: {
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

export function createPluginExtensionContext(
	base: GlobalExtensionContext,
	input: { pluginName: string; pathname: string },
): PluginExtensionContext {
	return {
		...base,
		pathname: input.pathname,
		pluginName: input.pluginName,
	}
}

export function isExtensionPluginRunning(ctx: ExtensionContext, pluginName: string): boolean {
	return ctx.runningPlugins.has(pluginName)
}

export function toGlobalExtensionContext(ctx: ExtensionContext): GlobalExtensionContext {
	if (!('pluginName' in ctx)) return ctx
	const { pluginName: _pluginName, pathname: _pathname, ...rest } = ctx
	return rest
}

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
	frame?: 'shell' | 'standalone'
}

type MetaProp<P extends ExtensionPoint> = ExtensionPointMap[P] extends { metaRequired: true }
	? { meta: ExtensionPointMeta<P> }
	: { meta?: ExtensionPointMeta<P> }

export type ExtensionDef<P extends ExtensionPoint = ExtensionPoint> = {
	point: P
	id: string
	priority?: number
	requireRunning?: boolean
	render: (ctx: ExtensionPointCtx<P>) => ReactNode
} & MetaProp<P>

export type AnyExtensionDef = { [P in ExtensionPoint]: ExtensionDef<P> }[ExtensionPoint]

export interface PluginUIModule {
	extensions?: AnyExtensionDef[]
	routes?: Array<{
		definition: RouteExtensionDef
		render: (ctx: PluginExtensionContext) => ReactNode
	}>
	i18n?: PluginI18nBundle | PluginI18nBundle[]
	setup?: (ctx: { pluginName: string }) => void | (() => void) | Promise<void | (() => void)>
}

export function definePluginUIModule<T extends PluginUIModule>(module: T): T {
	if (isDevEnvironment()) {
		validatePluginUIModule(module)
	}
	return module
}

function isDevEnvironment(): boolean {
	try {
		const metaEnv = (import.meta as any)?.env
		if (metaEnv && typeof metaEnv === 'object') {
			if (typeof metaEnv.PROD === 'boolean') return !metaEnv.PROD
			if (typeof metaEnv.DEV === 'boolean') return metaEnv.DEV
			if (typeof metaEnv.MODE === 'string') return metaEnv.MODE !== 'production'
		}
	} catch {}

	try {
		const p = (globalThis as any)?.process
		const nodeEnv = p?.env?.NODE_ENV
		if (typeof nodeEnv === 'string') return nodeEnv !== 'production'
	} catch {}

	return false
}

function validatePluginUIModule(module: PluginUIModule): void {
	if (!module || typeof module !== 'object') return

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

	if (Array.isArray(module.routes)) {
		const seen = new Set<string>()
		for (const route of module.routes) {
			const raw = route?.definition?.path
			const path = normalizeRoutePath(typeof raw === 'string' ? raw : '')
			if (!path) {
				console.error('[plugin-ui] Route path must be a non-empty string.', route)
				continue
			}
			const frame = (route as any)?.definition?.frame
			if (frame != null && frame !== 'shell' && frame !== 'standalone') {
				console.error('[plugin-ui] Route frame must be "shell" or "standalone".', route)
			}
			if ((route as any)?.definition?.addToNav === true && frame === 'standalone') {
				console.warn(
					'[plugin-ui] Route with frame="standalone" is added to nav; navigating will hide host chrome.',
					route,
				)
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
