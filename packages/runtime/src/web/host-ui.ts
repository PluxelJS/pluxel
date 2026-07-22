import { createContext, createElement, type ReactNode, useContext } from 'react'
import type { RuntimeTransportClient } from './client'

export const ExtensionPoints = {
	HeaderActions: 'header:actions',
	NavbarItems: 'navbar:items',
	NavbarFooter: 'navbar:footer',
	NavbarAuthText: 'navbar:authText',
	PluginHeader: 'plugin:header',
	PluginTabs: 'plugin:tabs',
	PluginActions: 'plugin:actions',
	PluginContext: 'plugin:context',
	PluginInfo: 'plugin:info',
	PluginDock: 'plugin:dock',
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

export function ExtensionProvider({
	value,
	children,
}: {
	value: ExtensionContext
	children: ReactNode
}) {
	return createElement(ExtensionCtx.Provider, { value }, children)
}

export function ExtensionPathnameProvider({
	value,
	children,
}: {
	value: string
	children: ReactNode
}) {
	return createElement(ExtensionPathnameCtx.Provider, { value }, children)
}

export function useExtensionContext(): ExtensionContext
export function useExtensionContext(kind: 'global'): GlobalExtensionContext
export function useExtensionContext(kind: 'plugin'): PluginExtensionContext
export function useExtensionContext(kind?: 'global' | 'plugin'): ExtensionContext {
	const ctx = useContext(ExtensionCtx)
	if (!ctx) throw new Error('useExtensionContext must be used within ExtensionProvider')
	if (kind === 'plugin') {
		if (!('pluginName' in ctx)) throw new Error('Plugin context required')
		return ctx
	}
	if (kind === 'global') return 'pluginName' in ctx ? toGlobalExtensionContext(ctx) : ctx
	return ctx
}

export const useGlobalExtensionContext = () => useExtensionContext('global')
export const usePluginExtensionContext = () => useExtensionContext('plugin')

export function useExtensionPathname(): string {
	const pluginCtx = useContext(ExtensionCtx)
	if (pluginCtx && 'pluginName' in pluginCtx) return pluginCtx.pathname
	const pathname = useContext(ExtensionPathnameCtx)
	if (pathname !== null) return pathname
	throw new Error('ExtensionPathnameProvider required')
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
			group?: {
				id: string
				label: string
				icon?: string | ReactNode
			}
		}
		metaRequired: true
	}
	'navbar:footer': {
		ctx: GlobalExtensionContext
		meta: { label?: string; href?: string; icon?: string | ReactNode }
		metaRequired?: false
	}
	'navbar:authText': { ctx: GlobalExtensionContext; meta: {}; metaRequired?: false }
	'plugin:header': {
		ctx: PluginExtensionContext
		meta: { label?: string; icon?: string | ReactNode }
		metaRequired?: false
	}
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
	'plugin:context': { ctx: PluginExtensionContext; meta: {}; metaRequired?: false }
	'plugin:info': { ctx: PluginExtensionContext; meta: {}; metaRequired?: false }
	'plugin:dock': { ctx: PluginExtensionContext; meta: {}; metaRequired?: false }
	'global:statusBar': {
		ctx: GlobalExtensionContext
		meta: { label?: string }
		metaRequired?: false
	}
}

export type ExtensionPoint = keyof ExtensionPointMap & string
export type ExtensionPointCtx<P extends ExtensionPoint> = ExtensionPointMap[P]['ctx']
export type ExtensionPointMeta<P extends ExtensionPoint> = ExtensionPointMap[P]['meta']

export interface LocaleService {
	readonly locale: string
	readonly fallbackLocale?: string
	setLocale(locale: string, options?: { fallbackLocale?: string }): void
	subscribe(listener: () => void): () => void
	formatDate(value: Date | number, options?: Intl.DateTimeFormatOptions): string
	formatNumber(value: number, options?: Intl.NumberFormatOptions): string
}

export interface UiNotifyPayload {
	title?: string
	message?: string
	tone?: 'info' | 'success' | 'warning' | 'error'
}
export interface UiConfirmPayload {
	title?: string
	message: string
	confirmLabel?: string
	cancelLabel?: string
	tone?: 'default' | 'danger'
}
export interface ExtensionServices {
	transport: RuntimeTransportClient
	ui: {
		notify(payload: UiNotifyPayload): void
		confirm(payload: UiConfirmPayload): Promise<boolean>
	}
	locale: LocaleService
}

export function createGlobalExtensionContext(
	input: GlobalExtensionContext,
): GlobalExtensionContext {
	return input
}

export function createPluginExtensionContext(
	base: GlobalExtensionContext,
	input: { pluginName: string; pathname: string },
): PluginExtensionContext {
	return { ...base, ...input }
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
	availabilityPluginName?: string
	priority: number
	requireRunning: boolean
}

export type ExtensionMeta<P extends ExtensionPoint = ExtensionPoint> = RuntimeMetaBase &
	ExtensionPointMeta<P>
export interface ExtensionItem<P extends ExtensionPoint = ExtensionPoint> {
	meta: ExtensionMeta<P>
	render: (ctx: ExtensionPointCtx<P>) => ReactNode
}
