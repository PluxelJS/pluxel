import {
	formatPluginNodeRoute,
	pluginNodeIndexKey,
	type Context as PluxelContext,
} from '@pluxel/core'
import { Elysia } from 'elysia'
import { isAbsolute, resolve } from 'pathe'

import {
	canAccessSecurityAdmin,
	createAdminAccessBlockedHeaders,
	createAdminAccessBlockedPayload,
	resolveAdminAccessRedirectPath,
	type AdminAccessBlockedKind,
	type AdminAccessReason,
} from '../../shared/admin-access-http'
import type { RenderHandler } from '../../server/types'
import { RUNTIME_INTERNAL_API_BASE, RUNTIME_SECURITY_BASE, UI_PUBLIC_BASE } from '../../web/paths'
import { buildAdminAccessRedirectPath, ADMIN_ACCESS_PAGE_PATH } from '../admin-access/transport'
import { matchesWorkbenchUiBasePath, normalizeWorkbenchUiBasePath } from '../../workbench-config'
import { createElysiaApp, type AnyElysiaApp, type CreateElysiaAppOptions } from './elysia'

export type HttpHandler = (
	req: Request,
	env?: unknown,
	ctx?: unknown,
) => Response | Promise<Response>

/**
 * Any WinterTC-style fetch boundary.
 *
 * Elysia is the preferred authoring model for plugin routes, but mounting stays framework-agnostic
 * so plugin integrations can still provide any fetch-compatible boundary.
 */
export type HttpBoundary = HttpHandler | { fetch: HttpHandler }

type RuntimeHttpUiAssetMode = 'dev-server' | 'static-built' | 'disabled'

/** @internal Workbench distribution inputs resolved by static/dynamic launchers. */
export type RuntimeHttpAssetConfig = Readonly<{
	uiAssets?: RuntimeHttpUiAssetMode
	uiPublicDir?: string
}>

export type RuntimeHttpHostConfig = RuntimeHttpAssetConfig &
	Readonly<{
		management: boolean
		workbench: boolean
		/**
		 * Directory for serving built UI assets (mounted under `UI_PUBLIC_BASE` when `uiAssets=static-built`).
		 *
		 * Defaults to the package's `dist/public` (when present).
		 */
		uiPublicDir?: string
		/** Browser path owned by the Workbench shell. Route launchers derive it from WorkbenchConfig. */
		uiBasePath: string
	}>

interface MountedBoundarySpec {
	id: string
	base: string
	boundary: HttpBoundary
}

export interface HttpBoundaryHandle {
	replace(boundary: HttpBoundary): void
	dispose(): void
}

type BaseElysiaApp = AnyElysiaApp

type UiPublicAssetHandler = (request: Request) => Promise<Response | null>
type InternalApiOptions = {
	workbench: boolean
}
type ResolvedHttpServiceConfig = {
	management: boolean
	workbench: boolean
	uiAssets: RuntimeHttpUiAssetMode
	uiPublicDir: string
	uiBasePath: string
}

export type ElysiaBoundaryBuilder = (app: BaseElysiaApp) => HttpBoundary

export interface ElysiaRouteMountOptions {
	app?: CreateElysiaAppOptions
}

export interface ElysiaRouteHandle extends HttpBoundaryHandle {
	replaceRoutes(build: ElysiaBoundaryBuilder): void
}

export interface HostHttpMountSpec {
	id: string
	path: string
	boundary: HttpBoundary
}

export interface PluginHttpMountOptions extends ElysiaRouteMountOptions {
	path?: string
	/**
	 * Mounts this plugin-owned boundary at a stable runtime-root path instead of the
	 * default `/__pluxel/plugins/<v1-node-route>` namespace. This changes routing only;
	 * authentication remains the plugin's responsibility.
	 */
	publicPath?: string
	id?: string
}

export interface HostHttpRouteOptions extends ElysiaRouteMountOptions {
	id: string
	path: string
}

type MountedBoundary = {
	id: string
	base: string
	install: (app: BaseElysiaApp) => BaseElysiaApp
}

export const PLUGIN_HTTP_BASE = '/__pluxel/plugins'

function normalizeMountBase(base: string): string {
	const raw = base.trim()
	if (!raw || raw === '/') return '/'
	return raw.startsWith('/') ? raw.replace(/\/+$/, '') || '/' : `/${raw.replace(/\/+$/, '')}`
}

function normalizePluginPath(path = '/'): string {
	const raw = path.trim()
	if (!raw || raw === '/') return '/'
	return raw.startsWith('/') ? raw.replace(/\/+$/, '') || '/' : `/${raw.replace(/\/+$/, '')}`
}

function normalizePluginPublicPath(path: string): string {
	const raw = path.trim()
	if (!raw.startsWith('/')) throw new Error('Plugin publicPath must be an absolute path')
	const normalized = normalizeMountBase(raw)
	if (normalized === '/') throw new Error('Plugin publicPath cannot own the runtime root')
	if (normalized === '/__pluxel' || normalized.startsWith('/__pluxel/')) {
		throw new Error('Plugin publicPath cannot use the reserved /__pluxel namespace')
	}
	return normalized
}

function currentWorkingDirectory(): string {
	const proc = (globalThis as unknown as { process?: { cwd?: () => string } }).process
	return typeof proc?.cwd === 'function' ? proc.cwd() : '/'
}

class HttpBackend {
	private fullReloadRequested = false
	private readonly mounted = new Map<string, MountedBoundary>()
	private mountedIndex: MountedBoundary[] = []
	private fetchPtr: HttpHandler = async () =>
		new Response('HTTP runtime unavailable', { status: 503 })
	private uiPublicHandler: UiPublicAssetHandler | null | undefined = undefined

	private readonly hostCtx: PluxelContext
	private readonly logger: NonNullable<PluxelContext['logger']>
	private renderer: Promise<RenderHandler> | null = null
	private readonly config: ResolvedHttpServiceConfig

	constructor(ctx: PluxelContext, config: RuntimeHttpHostConfig) {
		this.hostCtx = ctx.root
		this.logger = this.hostCtx.logger!
		this.config = {
			management: config.management,
			workbench: config.workbench,
			uiAssets: config.workbench ? (config.uiAssets ?? 'static-built') : 'disabled',
			uiPublicDir: config.uiPublicDir ?? '',
			uiBasePath: normalizeWorkbenchUiBasePath(config.uiBasePath),
		}
		if (config.management) {
			this.mountHostBoundary({
				id: 'pluxel:admin-access',
				path: ADMIN_ACCESS_PAGE_PATH,
				boundary: this.createLazyAdminAccessBoundary(),
			})
		}
		this.rebuildRootApp()
		if (config.management) {
			this.mountHostBoundary({
				id: 'hmr:internal-api',
				path: RUNTIME_INTERNAL_API_BASE,
				boundary: this.createLazyInternalApiBoundary({ workbench: config.workbench }),
			})
		}
	}

	get fetch() {
		return this.fetchPtr
	}

	/**
	 * Update UI asset serving mode for an already-instantiated HTTP runtime.
	 *
	 * HMR hosts can decide UI asset mode at process startup; if the HTTP service is already
	 * instantiated, it must be reconfigured in-place or it will keep serving the previous renderer.
	 */
	/** @internal Route launchers use this to switch between bundled and dev-server workbench UI assets. */
	reconfigureUiAssets(config: {
		uiAssets?: RuntimeHttpUiAssetMode
		uiPublicDir?: string
		uiBasePath?: string
	}): void {
		const nextUiAssets = config.uiAssets ?? 'static-built'
		const nextUiPublicDir = config.uiPublicDir ?? ''
		const nextUiBasePath =
			config.uiBasePath === undefined
				? this.config.uiBasePath
				: normalizeWorkbenchUiBasePath(config.uiBasePath)
		if (
			nextUiAssets === this.config.uiAssets &&
			nextUiPublicDir === this.config.uiPublicDir &&
			nextUiBasePath === this.config.uiBasePath
		) {
			return
		}

		this.config.uiAssets = nextUiAssets
		this.config.uiPublicDir = nextUiPublicDir
		this.config.uiBasePath = nextUiBasePath
		this.renderer = null
		this.uiPublicHandler = undefined
		this.rebuildRootApp()
		this.requestFullReload()
	}

	/**
	 * HMR integration hook: when runtime routes change (mount/replace/unmount),
	 * the UI usually needs a hard reload to refresh route bindings/state.
	 */
	consumeFullReloadRequest(): boolean {
		const value = this.fullReloadRequested
		this.fullReloadRequested = false
		return value
	}

	matchesMountedRoute(pathname: string): boolean {
		const path = normalizeMountBase(pathname)
		return this.mountedIndex.some((slot) => {
			if (slot.base === '/') return true
			return path === slot.base || path.startsWith(`${slot.base}/`)
		})
	}

	/** @internal Route launchers use the resolved host snapshot instead of reading Context config. */
	matchesWorkbenchUiRoute(pathname: string): boolean {
		return this.config.workbench && matchesWorkbenchUiBasePath(pathname, this.config.uiBasePath)
	}

	/** @internal Node static hosts use this to arbitrate the application root fallback. */
	workbenchOwnsRootNavigation(): boolean {
		return this.config.workbench && this.config.uiBasePath === '/'
	}

	pluginFor(pluginCtx: PluxelContext) {
		const owner = this.requirePluginOwner(pluginCtx)
		const ownerKey = pluginNodeIndexKey(owner)
		const ownerRoute = formatPluginNodeRoute(owner)
		const elysia = (options?: CreateElysiaAppOptions) => this.createApp(pluginCtx, options)
		return {
			owner,
			// Advanced escape hatch. Prefer `routes()` for normal Elysia route trees so
			// callers follow Elysia's chaining model and can replace mounted trees safely.
			elysia,
			app: elysia,
			base: (path = '/') => this.resolvePluginBase(ownerRoute, path),
			routes: (build: ElysiaBoundaryBuilder, options: PluginHttpMountOptions = {}) =>
				this.mountPluginRoutes(pluginCtx, ownerKey, ownerRoute, build, options),
			mount: (boundary: HttpBoundary, options: PluginHttpMountOptions = {}) =>
				this.mountPluginBoundary(pluginCtx, ownerKey, ownerRoute, boundary, options),
		}
	}

	get host() {
		const elysia = (options?: CreateElysiaAppOptions) => this.createApp(this.hostCtx, options)
		return {
			// Advanced escape hatch. Prefer `routes()` for normal Elysia route trees.
			elysia,
			app: elysia,
			routes: (build: ElysiaBoundaryBuilder, options: HostHttpRouteOptions) =>
				this.mountHostRoutes(build, options),
			mount: (spec: HostHttpMountSpec) => this.mountHostBoundary(spec),
		}
	}

	private mountHostBoundary(spec: HostHttpMountSpec): HttpBoundaryHandle {
		return this.mountAtPath(this.hostCtx, {
			id: spec.id,
			base: spec.path,
			boundary: spec.boundary,
		})
	}

	private createLazyAdminAccessBoundary(): HttpHandler {
		let appPromise: Promise<BaseElysiaApp> | undefined
		return async (request) => {
			appPromise ??= import('../admin-access/http').then(({ createAdminAccessRoutes }) =>
				createAdminAccessRoutes(
					this.hostCtx,
					this.createApp(this.hostCtx, {
						aot: true,
						name: 'pluxel.http.admin-access',
					}),
				),
			)
			const app = await appPromise
			return app.fetch(request)
		}
	}

	private createLazyInternalApiBoundary(options: InternalApiOptions): HttpHandler {
		let boundaryPromise: Promise<HttpBoundary> | undefined
		return async (request) => {
			boundaryPromise ??= import('./internalApi').then(({ createInternalApiRoutes }) => {
				const build = createInternalApiRoutes(this.hostCtx, options)
				return build(
					this.createApp(this.hostCtx, {
						aot: true,
						name: 'pluxel.http.internal',
					}),
				)
			})
			const boundary = await boundaryPromise
			return this.toFetch(boundary)(request)
		}
	}

	private mountPluginBoundary(
		pluginCtx: PluxelContext,
		ownerKey: string,
		ownerRoute: string,
		boundary: HttpBoundary,
		options: PluginHttpMountOptions = {},
	): HttpBoundaryHandle {
		if (options.path !== undefined && options.publicPath !== undefined) {
			throw new Error('Plugin HTTP mount cannot combine path and publicPath')
		}
		const path = normalizePluginPath(options.path)
		const base =
			options.publicPath === undefined
				? this.resolvePluginBase(ownerRoute, path)
				: normalizePluginPublicPath(options.publicPath)
		const routeId = options.id ?? this.defaultPluginBoundaryId(ownerKey, path, options.publicPath)
		return this.mountAtPath(pluginCtx, {
			id: routeId,
			base,
			boundary,
		})
	}

	private mountPluginRoutes(
		pluginCtx: PluxelContext,
		ownerKey: string,
		ownerRoute: string,
		build: ElysiaBoundaryBuilder,
		options: PluginHttpMountOptions = {},
	): ElysiaRouteHandle {
		const { app: appOptions, ...mountOptions } = options
		const createBoundary = (nextBuild: ElysiaBoundaryBuilder) =>
			nextBuild(this.createApp(pluginCtx, appOptions))
		const handle = this.mountPluginBoundary(
			pluginCtx,
			ownerKey,
			ownerRoute,
			createBoundary(build),
			mountOptions,
		)

		return {
			...handle,
			replaceRoutes: (nextBuild) => handle.replace(createBoundary(nextBuild)),
		}
	}

	private mountHostRoutes(
		build: ElysiaBoundaryBuilder,
		options: HostHttpRouteOptions,
	): ElysiaRouteHandle {
		const { app: appOptions, ...mountSpec } = options
		const createBoundary = (nextBuild: ElysiaBoundaryBuilder) =>
			nextBuild(this.createApp(this.hostCtx, appOptions))
		const handle = this.mountHostBoundary({
			...mountSpec,
			boundary: createBoundary(build),
		})

		return {
			...handle,
			replaceRoutes: (nextBuild) => handle.replace(createBoundary(nextBuild)),
		}
	}

	private mountAtPath(ownerCtx: PluxelContext, spec: MountedBoundarySpec): HttpBoundaryHandle {
		let slot: MountedBoundary | undefined
		let active = true
		const dispose = () => {
			if (!active) return
			active = false
			if (!slot || this.mounted.get(slot.id) !== slot) return
			if (this.mounted.delete(slot.id)) {
				this.refreshMountedIndex()
				this.rebuildRootApp()
				this.requestFullReload()
			}
		}
		const guard = ownerCtx.effects.defer(dispose)
		try {
			slot = this.upsertMounted(spec)
		} catch (error) {
			guard.cancel()
			throw error
		}

		return {
			replace: (boundary) => {
				if (!active || !guard.active || !slot || this.mounted.get(slot.id) !== slot) {
					throw new Error('[pluxel/http] HTTP route handle is disposed')
				}
				slot = this.upsertMounted({ ...spec, boundary })
				this.requestFullReload()
			},
			dispose: () => guard.dispose(),
		}
	}

	private async resolveUiPublicDir(): Promise<string | null> {
		if (this.config.uiAssets !== 'static-built') return null
		const configured = String(this.config.uiPublicDir ?? '').trim()
		if (configured)
			return isAbsolute(configured) ? configured : resolve(currentWorkingDirectory(), configured)
		const { resolveDefaultUiPublicDir } = await import('../../server/ui-public')
		return resolveDefaultUiPublicDir()
	}

	private async uiPublic(): Promise<UiPublicAssetHandler | null> {
		if (this.uiPublicHandler !== undefined) return this.uiPublicHandler
		const dir = await this.resolveUiPublicDir()
		if (!dir) {
			this.uiPublicHandler = null
			return null
		}
		const { createUiPublicAssetHandler } = await import('../../server/ui-public')
		this.uiPublicHandler = createUiPublicAssetHandler({ publicDirAbs: dir })
		return this.uiPublicHandler
	}

	private rebuildRootApp() {
		const root = createElysiaApp(this.hostCtx, {
			aot: true,
			name: 'pluxel.http.root',
		})

		for (const slot of this.mountedIndex) slot.install(root)

		const fallback = async ({ request }: { request: Request }) => {
			const url = new URL(request.url)
			const path = url.pathname
			const method = (request.method ?? 'GET').toUpperCase()

			if (path.startsWith(`${UI_PUBLIC_BASE}/`)) {
				if (this.config.uiAssets === 'disabled') return new Response('Not Found', { status: 404 })
				const denied = await this.guardUiRequest(request, path, method, 'ui')
				if (denied) return denied
				const uiPublic = await this.uiPublic()
				if (!uiPublic) return new Response('Not Found', { status: 404 })
				return (await uiPublic(request)) ?? new Response('Not Found', { status: 404 })
			}

			if (
				this.isHtmlNavigation(request) &&
				matchesWorkbenchUiBasePath(path, this.config.uiBasePath)
			) {
				if (this.config.uiAssets === 'disabled') return new Response('Not Found', { status: 404 })
				const denied = await this.guardUiRequest(request, path, method, 'ui')
				if (denied) return denied
				return this.render(request)
			}

			return new Response('Not Found', { status: 404 })
		}

		root.get('/', fallback).all('/*', fallback)
		root.compile()
		this.fetchPtr = (request) => root.fetch(request)
	}

	private async guardUiRequest(
		request: Request,
		path: string,
		method: string,
		kind: AdminAccessBlockedKind,
	): Promise<Response | undefined> {
		const adminAccess = this.hostCtx.root.adminAccess
		if (!adminAccess) {
			throw new Error('[pluxel/runtime] Workbench UI requires the management plane')
		}
		const state = await adminAccess.authorize({
			headers: request.headers,
			request,
			url: request.url,
		})
		const isSecurityRoute =
			path === RUNTIME_SECURITY_BASE || path.startsWith(`${RUNTIME_SECURITY_BASE}/`)
		const isSecurityCarrier = path === UI_PUBLIC_BASE || path.startsWith(`${UI_PUBLIC_BASE}/`)
		if ((isSecurityRoute || isSecurityCarrier) && canAccessSecurityAdmin(state)) return undefined
		if (isSecurityRoute) {
			this.logger.warn('Blocked host security admin route', {
				kind,
				path,
				method,
				reason: state.reason,
			})
			return this.buildAdminAccessDeniedResponse(request, path, method, kind, state.reason)
		}
		if (state.allow) return undefined

		this.logger.warn('Blocked admin access gate', {
			kind,
			path,
			method,
			reason: state.reason,
		})

		return this.buildAdminAccessDeniedResponse(request, path, method, kind, state.reason)
	}

	private buildAdminAccessDeniedResponse(
		request: Request,
		path: string,
		method: string,
		kind: AdminAccessBlockedKind,
		reason?: AdminAccessReason,
	): Response {
		const redirectPath = resolveAdminAccessRedirectPath(
			buildAdminAccessRedirectPath,
			request,
			kind,
			reason,
		)
		if (kind === 'ui') {
			return new Response(null, {
				status: 302,
				headers: {
					Location: redirectPath,
					'Cache-Control': 'no-store',
				},
			})
		}

		return Response.json(
			createAdminAccessBlockedPayload(path, method, kind, redirectPath, reason),
			{
				status: 401,
				headers: createAdminAccessBlockedHeaders(redirectPath, reason),
			},
		)
	}

	private isHtmlNavigation(req: Request): boolean {
		const headers = req.headers
		const method = (req.method ?? 'GET').toUpperCase()
		if (method !== 'GET' && method !== 'HEAD') return false

		const accept = (headers.get('accept') ?? '').toLowerCase()
		if (!accept.includes('text/html') && !accept.includes('*/*')) return false

		const fetchMode = headers.get('sec-fetch-mode')
		if (fetchMode && fetchMode !== 'navigate') return false

		const fetchDest = headers.get('sec-fetch-dest')
		if (fetchDest && fetchDest !== 'document' && fetchDest !== 'iframe') return false

		return true
	}

	private upsertMounted(spec: MountedBoundarySpec): MountedBoundary {
		const base = normalizeMountBase(spec.base)
		const conflict = this.mountedIndex.find((slot) => slot.id !== spec.id && slot.base === base)
		if (conflict) {
			throw new Error(
				`HTTP mount path "${base}" is already owned by "${conflict.id}"; "${spec.id}" cannot mount the same path`,
			)
		}
		const slot: MountedBoundary = {
			id: spec.id,
			base,
			install: this.toInstaller(spec.id, base, spec.boundary),
		}
		this.mounted.set(slot.id, slot)
		this.refreshMountedIndex()
		this.rebuildRootApp()
		return slot
	}

	private wrapMountedFetch(id: string, base: string, fetch: HttpHandler): HttpHandler {
		return async (request, env, ctx) => {
			try {
				return await fetch(request, env, ctx)
			} catch (error) {
				this.logger.error('Mounted module request failed', {
					error,
					id,
					base,
					path: new URL(request.url).pathname,
					method: (request.method ?? 'GET').toUpperCase(),
				})
				return new Response('Internal server error', { status: 500 })
			}
		}
	}

	private toInstaller(id: string, base: string, boundary: HttpBoundary) {
		if (this.isElysiaBoundary(boundary)) {
			const plugin = this.wrapMountedPlugin(id, base, boundary)
			return (app: BaseElysiaApp) => app.use(plugin)
		}

		const fetch = this.wrapMountedFetch(id, base, this.toFetch(boundary))
		return (app: BaseElysiaApp) => {
			if (base === '/') app.mount(fetch)
			else app.mount(base, fetch)
			return app
		}
	}

	private wrapMountedPlugin(id: string, base: string, boundary: BaseElysiaApp): BaseElysiaApp {
		const prefix = base === '/' ? undefined : base
		return createElysiaApp(this.hostCtx, {
			aot: true,
			name: `pluxel.http.boundary.${id}`,
			prefix,
		}).use(boundary)
	}

	private toFetch(boundary: HttpBoundary): HttpHandler {
		if (typeof boundary === 'function') return boundary
		return boundary.fetch.bind(boundary)
	}

	private isElysiaBoundary(boundary: HttpBoundary): boundary is BaseElysiaApp {
		return boundary instanceof Elysia
	}

	private requirePluginOwner(ctx: PluxelContext) {
		const owner = ctx.pluginInfo?.nodeAddress
		if (!owner) throw new Error('Plugin-scoped HTTP routes require a Plugin node owner')
		return owner
	}

	private resolvePluginBase(ownerRoute: string, path = '/'): string {
		const suffix = normalizePluginPath(path)
		const base = `${PLUGIN_HTTP_BASE}/${ownerRoute}`
		return suffix === '/' ? base : `${base}${suffix}`
	}

	private defaultPluginBoundaryId(
		ownerKey: string,
		path: string,
		publicPath: string | undefined,
	): string {
		if (publicPath !== undefined) {
			return `${ownerKey}:http:public:${normalizePluginPublicPath(publicPath).slice(1).replaceAll('/', ':')}`
		}
		return path === '/'
			? `${ownerKey}:http`
			: `${ownerKey}:http:${path.slice(1).replaceAll('/', ':')}`
	}

	private requestFullReload() {
		this.fullReloadRequested = true
	}

	private refreshMountedIndex() {
		this.mountedIndex = [...this.mounted.values()].sort((a, b) => b.base.length - a.base.length)
	}

	private createApp(ctx: PluxelContext, options?: CreateElysiaAppOptions) {
		return createElysiaApp(ctx, options)
	}

	private async createRenderer(): Promise<RenderHandler> {
		if (this.config.uiAssets === 'disabled') {
			return () => new Response('Not Found', { status: 404 })
		}
		if (this.config.uiAssets === 'static-built') {
			const { createStaticRenderer } = await import('../../server/static')
			return createStaticRenderer({
				publicDirAbs: (await this.resolveUiPublicDir()) ?? undefined,
				uiBasePath: this.config.uiBasePath,
			})
		}
		const { createHmrRenderer } = await import('../../server/hmr')
		return createHmrRenderer({ uiBasePath: this.config.uiBasePath })
	}

	private async render(request: Request) {
		const handler = await (this.renderer ??= this.createRenderer())
		return handler(request)
	}
}

/**
 * Immutable owner view over the root HTTP backend.
 *
 * Every Context caches one ordinary view object. Server state, route indexes and rendering state
 * remain in the single root backend; the view only carries the Context that owns registrations.
 */
export class HttpService {
	readonly #backend: HttpBackend

	private constructor(
		public readonly ctx: PluxelContext,
		backend: HttpBackend,
	) {
		this.#backend = backend
		Object.freeze(this)
	}

	/** @internal Runtime host composition creates the sole HTTP backend. */
	static createRoot(ctx: PluxelContext, config: RuntimeHttpHostConfig): HttpService {
		return new HttpService(ctx, new HttpBackend(ctx, config))
	}

	/** @internal Create one proxy-free owner view without constructing another HTTP backend. */
	forOwner(owner: PluxelContext): HttpService {
		return new HttpService(owner, this.#backend)
	}

	get fetch(): HttpHandler {
		return this.#backend.fetch
	}

	reconfigureUiAssets(config: {
		uiAssets?: RuntimeHttpUiAssetMode
		uiPublicDir?: string
		uiBasePath?: string
	}): void {
		this.#backend.reconfigureUiAssets(config)
	}

	consumeFullReloadRequest(): boolean {
		return this.#backend.consumeFullReloadRequest()
	}

	matchesMountedRoute(pathname: string): boolean {
		return this.#backend.matchesMountedRoute(pathname)
	}

	matchesWorkbenchUiRoute(pathname: string): boolean {
		return this.#backend.matchesWorkbenchUiRoute(pathname)
	}

	workbenchOwnsRootNavigation(): boolean {
		return this.#backend.workbenchOwnsRootNavigation()
	}

	get plugin(): ReturnType<HttpBackend['pluginFor']> {
		return this.#backend.pluginFor(this.ctx)
	}

	get host(): HttpBackend['host'] {
		if (this.ctx !== this.ctx.root) {
			throw new Error('[pluxel/http] HTTP host API requires the root Context')
		}
		return this.#backend.host
	}
}
