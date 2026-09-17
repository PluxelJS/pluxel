import type { Context as PluxelContext } from '@pluxel/core'
import { Elysia } from 'elysia'
import type { WSConnectionData } from 'elysia/ws'
import { isAbsolute, resolve } from 'pathe'

import type { RenderHandler } from '@pluxel/workbench/internal/shell'
import {
	RUNTIME_INTERNAL_API_BASE,
	UI_PUBLIC_ASSET_BASE,
} from '@pluxel/management/internal/web/paths'
import { matchesWorkbenchUiBasePath, normalizeWorkbenchUiBasePath } from '../../workbench-config'
import { matchesRuntimeSessionUpgrade } from '@pluxel/management/internal/web/session/ingress'
import { RUNTIME_SESSION_PATH } from '@pluxel/management/internal/web/session/protocol'
import {
	isLoopbackAddress,
	createManagementEndpoint,
	type ManagementEndpoint,
	type ManagementPeer,
} from '@pluxel/management/internal/web/session/endpoint'
import { RuntimeManagementTargetImpl } from '@pluxel/management/internal/services/management/RuntimeManagementTarget'
import { requireWorkbench, createWorkbenchArtifactHandler } from '@pluxel/workbench/server'
import {
	createHostElysiaApp,
	type AnyHostElysiaApp,
	type CreateHostElysiaAppOptions,
} from './elysia'
import type { ElysiaApplicationDirectory } from '@pluxel/services/internal/http'
import type { ElysiaApplicationCarrier, ElysiaCarrierRequestAddress } from '@pluxel/services/http'

type HttpHandler = (req: Request, env?: unknown, ctx?: unknown) => Response | Promise<Response>

/**
 * Any WinterTC-style fetch boundary.
 *
 * Elysia is the preferred authoring model for plugin routes, but mounting stays framework-agnostic
 * so plugin integrations can still provide any fetch-compatible boundary.
 */
type MountedFetchBoundary = HttpHandler | { fetch: HttpHandler }

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
		/** @internal Test-only peer seam used only when no physical carrier is attached. */
		requestAddress?: (request: Request) => ElysiaCarrierRequestAddress | null
	}>

interface MountedBoundarySpec {
	id: string
	base: string
	boundary: MountedFetchBoundary
}

interface MountedFetchBoundaryHandle {
	replace(boundary: MountedFetchBoundary): void
	dispose(): void
}

type BaseElysiaApp = AnyHostElysiaApp

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

export type HostElysiaBuilder = (app: BaseElysiaApp) => MountedFetchBoundary

interface HostHttpMountSpec {
	id: string
	path: string
	boundary: MountedFetchBoundary
}

type MountedBoundary = {
	id: string
	base: string
	install: (app: BaseElysiaApp) => BaseElysiaApp
}

function normalizeMountBase(base: string): string {
	const raw = base.trim()
	if (!raw || raw === '/') return '/'
	return raw.startsWith('/') ? raw.replace(/\/+$/, '') || '/' : `/${raw.replace(/\/+$/, '')}`
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
	private readonly applications: ElysiaApplicationDirectory
	private readonly requestAddress?: RuntimeHttpHostConfig['requestAddress']
	private applicationCarrier?: ElysiaApplicationCarrier
	private endpoint?: ManagementEndpoint

	constructor(
		ctx: PluxelContext,
		config: RuntimeHttpHostConfig,
		applications: ElysiaApplicationDirectory,
	) {
		this.hostCtx = ctx.root
		this.applications = applications
		this.requestAddress = config.requestAddress
		this.logger = this.hostCtx.logger!
		this.config = {
			management: config.management,
			workbench: config.workbench,
			uiAssets: config.workbench ? (config.uiAssets ?? 'static-built') : 'disabled',
			uiPublicDir: config.uiPublicDir ?? '',
			uiBasePath: normalizeWorkbenchUiBasePath(config.uiBasePath),
		}
		ctx.effects.defer(() => this.endpoint?.close(), {
			tag: 'ManagementEndpoint',
			phase: 'shutdown',
		})
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
		return (request: Request, env?: unknown, ctx?: unknown) => this.fetchIngress(request, env, ctx)
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
		return (
			this.applications.matchesHttpRoute(pathname) ||
			this.mountedIndex.some((slot) => {
				if (slot.base === '/') return true
				return path === slot.base || path.startsWith(`${slot.base}/`)
			})
		)
	}

	/** @internal Route launchers use the resolved host snapshot instead of reading Context config. */
	matchesWorkbenchUiRoute(pathname: string): boolean {
		return this.config.workbench && matchesWorkbenchUiBasePath(pathname, this.config.uiBasePath)
	}

	/** @internal Node static hosts use this to arbitrate the application root fallback. */
	workbenchOwnsRootNavigation(): boolean {
		return this.config.workbench && this.config.uiBasePath === '/'
	}

	/** @internal Vite route launchers use this for user-facing development URLs. */
	workbenchUiBasePath(): string | undefined {
		return this.config.workbench ? this.config.uiBasePath : undefined
	}

	attachApplicationCarrier(carrier: ElysiaApplicationCarrier): () => void {
		if (this.applicationCarrier) {
			throw new Error('[pluxel/runtime] An Elysia application carrier is already attached')
		}
		this.applicationCarrier = carrier
		const detachDirectory = this.applications.attachApplicationCarrier(carrier)
		let active = true
		return () => {
			if (!active) return
			active = false
			this.endpoint?.close()
			this.endpoint = undefined
			detachDirectory()
			if (this.applicationCarrier === carrier) this.applicationCarrier = undefined
		}
	}

	matchesWebSocketRoute(request: Request): boolean {
		return (
			(this.config.management && matchesRuntimeSessionUpgrade(request)) ||
			this.applications.matchesWebSocketRoute(request)
		)
	}

	private mountHostBoundary(spec: HostHttpMountSpec): MountedFetchBoundaryHandle {
		return this.mountAtPath(this.hostCtx, {
			id: spec.id,
			base: spec.path,
			boundary: spec.boundary,
		})
	}

	private createLazyInternalApiBoundary(options: InternalApiOptions): HttpHandler {
		let boundaryPromise: Promise<MountedFetchBoundary> | undefined
		return async (request) => {
			boundaryPromise ??= import('./internalApi').then(({ createInternalApiRoutes }) => {
				const build = createInternalApiRoutes(this.hostCtx, options)
				return build(
					this.createApp(this.hostCtx, {
						precompile: true,
						name: 'pluxel.http.internal',
					}),
				)
			})
			const boundary = await boundaryPromise
			return this.toFetch(boundary)(request)
		}
	}

	private mountAtPath(
		ownerCtx: PluxelContext,
		spec: MountedBoundarySpec,
	): MountedFetchBoundaryHandle {
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
		const { resolveDefaultUiPublicDir } = await import('@pluxel/workbench/internal/shell')
		return resolveDefaultUiPublicDir()
	}

	private async uiPublic(): Promise<UiPublicAssetHandler | null> {
		if (this.uiPublicHandler !== undefined) return this.uiPublicHandler
		const dir = await this.resolveUiPublicDir()
		if (!dir) {
			this.uiPublicHandler = null
			return null
		}
		const { createUiPublicAssetHandler } = await import('@pluxel/workbench/internal/shell')
		this.uiPublicHandler = createUiPublicAssetHandler({ publicDirAbs: dir })
		return this.uiPublicHandler
	}

	private async fetchIngress(request: Request, env?: unknown, ctx?: unknown): Promise<Response> {
		const url = new URL(request.url)
		const path = url.pathname
		const facts = this.requestFacts(request)
		if (path === RUNTIME_SESSION_PATH) {
			return await this.fetchRuntimeSession(request, facts)
		}

		if (this.config.management) {
			const handled = await this.managementEndpoint().fetch(request, facts)
			if (handled) return handled
		}
		return await this.fetchPtr(request, env, ctx)
	}

	private managementEndpoint(): ManagementEndpoint {
		if (this.endpoint) return this.endpoint
		const authentication = this.hostCtx.root.adminAccess
		if (!authentication) throw new Error('[runtime] Management endpoint requires authentication')
		return (this.endpoint = createManagementEndpoint({
			authentication,
			...(this.config.workbench ? { artifacts: createWorkbenchArtifactHandler(this.hostCtx) } : {}),
			createManagement: (session) => new RuntimeManagementTargetImpl(this.hostCtx, session.signal),
			...(this.config.workbench
				? {
						createWorkbench: (principal, invalidate) =>
							requireWorkbench(this.hostCtx).createSession(principal, invalidate),
					}
				: {}),
			onError: (error) => this.logger.error('Runtime control operation failed', { error }),
		}))
	}

	private async fetchRuntimeSession(request: Request, peer: ManagementPeer): Promise<Response> {
		const headers = { 'cache-control': 'no-store' }
		if (!this.config.management) return new Response('Not Found', { status: 404, headers })
		const carrier = this.applicationCarrier
		const endpoint = this.managementEndpoint()
		const prepared = endpoint.prepareUpgrade(request, peer)
		if (prepared.accepted === false) return prepared.response
		const ingress = prepared.connection
		if (!carrier) {
			ingress.release()
			return new Response('Runtime session carrier unavailable.', { status: 503, headers })
		}
		const accepted = carrier.upgrade(
			Object.freeze({
				request,
				upgradeRequest: request,
				ownerKey: 'pluxel.runtime.control',
				data: {
					id: undefined,
					context: Object.freeze({ pluxelRuntimeSession: true }),
					open: (socket) =>
						ingress.open({
							get readyState() {
								return socket.readyState
							},
							send: (message) => {
								const status = socket.send(message)
								return typeof status === 'number' ? status > 0 : undefined
							},
							close: (code, reason) => socket.raw.close(code, reason),
						}),
					message: (_socket, message) => ingress.receive(message),
					close: (_socket, code, reason) => ingress.transportClosed(code, reason),
				} satisfies WSConnectionData,
				signal: ingress.signal,
				release: () => ingress.release(),
			}),
		)
		if (!accepted) {
			ingress.release()
			return new Response('Runtime session upgrade unavailable.', { status: 503, headers })
		}
		// The existing carrier adapter consumes this response after taking ownership of the upgrade.
		return new Response(null, { status: 204, headers })
	}

	private requestFacts(
		request: Request,
	): ManagementPeer & Readonly<{ local: boolean; secure: boolean }> {
		let address: ElysiaCarrierRequestAddress | null = null
		try {
			address = this.applicationCarrier
				? this.applicationCarrier.requestIP(request)
				: (this.requestAddress?.(request) ?? null)
		} catch {
			address = null
		}
		let secure = false
		let origin: string | undefined
		try {
			if (this.applicationCarrier) {
				const metadata = this.applicationCarrier.metadata
				secure = metadata.url.protocol === 'https:'
				origin = metadata.url.origin
			} else {
				const url = new URL(request.url)
				secure = url.protocol === 'https:'
				// Explicit isolated-test peer resolver is the only non-carrier source of trusted URL facts.
				if (this.requestAddress) origin = url.origin
			}
		} catch {
			secure = false
		}
		return Object.freeze({
			address: address?.address,
			local: isLoopbackAddress(address?.address),
			secure,
			origin,
		})
	}

	private rebuildRootApp() {
		const root = createHostElysiaApp(this.hostCtx, {
			precompile: true,
			name: 'pluxel.http.root',
		})

		for (const slot of this.mountedIndex) slot.install(root)

		const fallback = async ({ request }: { request: Request }) => {
			const url = new URL(request.url)
			const path = url.pathname
			const business = await this.applications.dispatch(request)
			if (business) return business

			if (path.startsWith(`${UI_PUBLIC_ASSET_BASE}/`)) {
				if (this.config.uiAssets === 'disabled') return new Response('Not Found', { status: 404 })
				const uiPublic = await this.uiPublic()
				if (!uiPublic) return new Response('Not Found', { status: 404 })
				return (await uiPublic(request)) ?? new Response('Not Found', { status: 404 })
			}

			if (
				this.isHtmlNavigation(request) &&
				matchesWorkbenchUiBasePath(path, this.config.uiBasePath)
			) {
				if (this.config.uiAssets === 'disabled') return new Response('Not Found', { status: 404 })
				return this.render(request)
			}

			return new Response('Not Found', { status: 404 })
		}

		root.get('/', fallback).all('/*', fallback)
		root.compile()
		this.fetchPtr = (request) => root.fetch(request)
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

	private toInstaller(id: string, base: string, boundary: MountedFetchBoundary) {
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
		return createHostElysiaApp(this.hostCtx, {
			precompile: true,
			name: `pluxel.http.boundary.${id}`,
			prefix,
		}).use(boundary)
	}

	private toFetch(boundary: MountedFetchBoundary): HttpHandler {
		if (typeof boundary === 'function') return boundary
		return boundary.fetch.bind(boundary)
	}

	private isElysiaBoundary(boundary: MountedFetchBoundary): boundary is BaseElysiaApp {
		return boundary instanceof Elysia
	}

	private requestFullReload() {
		this.fullReloadRequested = true
	}

	private refreshMountedIndex() {
		this.mountedIndex = [...this.mounted.values()].sort((a, b) => b.base.length - a.base.length)
	}

	private createApp(ctx: PluxelContext, options?: CreateHostElysiaAppOptions) {
		return createHostElysiaApp(ctx, options)
	}

	private async createRenderer(): Promise<RenderHandler> {
		if (this.config.uiAssets === 'disabled') {
			return () => new Response('Not Found', { status: 404 })
		}
		if (this.config.uiAssets === 'static-built') {
			const { createStaticRenderer } = await import('@pluxel/workbench/internal/shell')
			return createStaticRenderer({
				publicDirAbs: (await this.resolveUiPublicDir()) ?? undefined,
				uiBasePath: this.config.uiBasePath,
			})
		}
		const { createHmrRenderer } = await import('@pluxel/workbench/internal/shell')
		return createHmrRenderer({ uiBasePath: this.config.uiBasePath })
	}

	private async render(request: Request) {
		const handler = await (this.renderer ??= this.createRenderer())
		return handler(request)
	}
}

export { isLoopbackAddress } from '@pluxel/management/internal/web/session/endpoint'

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
	static createRoot(
		ctx: PluxelContext,
		config: RuntimeHttpHostConfig,
		applications: ElysiaApplicationDirectory,
	): HttpService {
		return new HttpService(ctx, new HttpBackend(ctx, config, applications))
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

	/** @internal Vite route launchers use this for user-facing development URLs. */
	workbenchUiBasePath(): string | undefined {
		return this.#backend.workbenchUiBasePath()
	}

	/** @internal Launchers attach the physical platform bridge after creating the root. */
	attachApplicationCarrier(carrier: ElysiaApplicationCarrier): () => void {
		return this.#backend.attachApplicationCarrier(carrier)
	}

	/** @internal Vite/Node upgrade arbiters use the native Elysia directory matcher. */
	matchesWebSocketRoute(request: Request): boolean {
		return this.#backend.matchesWebSocketRoute(request)
	}
}
