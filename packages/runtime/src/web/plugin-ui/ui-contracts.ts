import { createContext, createElement, type ReactNode, useContext } from 'react'
import type { RuntimeTransportClient } from '../client'
import type { InteractionContractRef } from './interaction-contracts'

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

export function useGlobalExtensionContext(): GlobalExtensionContext {
	return useExtensionContext('global')
}

export function usePluginExtensionContext(): PluginExtensionContext {
	return useExtensionContext('plugin')
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

export type Locale = string

export interface LocaleService {
	readonly locale: Locale
	readonly fallbackLocale?: Locale
	setLocale(locale: Locale, options?: { fallbackLocale?: Locale }): void
	subscribe(listener: () => void): () => void
	formatDate(value: Date | number, options?: Intl.DateTimeFormatOptions): string
	formatNumber(value: number, options?: Intl.NumberFormatOptions): string
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
	transport: RuntimeTransportClient
	ui: {
		notify: (payload: UiNotifyPayload) => void
		confirm: (payload: UiConfirmPayload) => Promise<boolean>
	}
	locale: LocaleService
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

export type InteractionSessionPhase = 'ready' | 'syncing-draft' | 'committing'

export type InteractionSessionComponentProps<
	TInput = unknown,
	TDraft = unknown,
	TPrepared = unknown,
	TResult = unknown,
> = {
	sessionId: string
	targetPlugin: string
	providerPlugin: string
	surfaceId: string
	offerId: string
	contract: InteractionContractRef
	input: TInput
	prepared: TPrepared
	draft: TDraft
	setDraft: (next: TDraft | ((prev: TDraft) => TDraft)) => void
	patchDraft: (patch: Partial<TDraft>) => void
	pushDraft: (next?: TDraft) => Promise<void>
	commit: (result: TResult) => Promise<void>
	reload: () => Promise<void>
	disabled?: boolean
	phase: InteractionSessionPhase
}

export type InteractionSessionComponent<
	TInput = unknown,
	TDraft = unknown,
	TPrepared = unknown,
	TResult = unknown,
> = (props: InteractionSessionComponentProps<TInput, TDraft, TPrepared, TResult>) => ReactNode

export interface PluginUIModule {
	extensions?: AnyExtensionDef[]
	sessions?: Record<string, InteractionSessionComponent<any, any, any, any>>
	routes?: Array<{
		definition: RouteExtensionDef
		render: (ctx: PluginExtensionContext) => ReactNode
	}>
	setup?: (ctx: {
		pluginName: string
		locale: LocaleService
	}) => void | (() => void) | Promise<void | (() => void)>
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

	if (module.sessions && typeof module.sessions === 'object') {
		for (const [sessionKey, session] of Object.entries(module.sessions)) {
			if (!sessionKey.trim()) {
				console.error('[plugin-ui] Session key must be a non-empty string.', module.sessions)
				continue
			}
			if (typeof session !== 'function') {
				console.error('[plugin-ui] Session component must be a function.', sessionKey, session)
			}
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
