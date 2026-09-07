import type { Context as PluxelContext } from '@pluxel/core'
import { Elysia } from 'elysia'
import { isAbsolute, resolve } from 'pathe'

import type { AdminAccessReason } from '../admin-access/types'
import type { RenderHandler } from '../../server/types'
import {
	RUNTIME_INTERNAL_API_BASE,
	RUNTIME_WORKBENCH_FEDERATION_BASE,
	UI_PUBLIC_ASSET_BASE,
} from '../../web/paths'
import { isAdminAccessHandoffPath } from '../admin-access/transport'
import { responseWithLease } from '../admin-access/response-lifetime'
import { matchesWorkbenchUiBasePath, normalizeWorkbenchUiBasePath } from '../../workbench-config'
import {
	matchesRuntimeSessionUpgrade,
	RuntimeSessionIngress,
	validateRuntimeSessionOrigin,
} from '../../web/session/ingress'
import { RUNTIME_SESSION_PATH } from '../../web/session/protocol'
import {
	createHostElysiaApp,
	type AnyHostElysiaApp,
	type CreateHostElysiaAppOptions,
} from './elysia'
import type { ElysiaApplicationDirectory } from './ElysiaApplicationDirectory'
import type {
	ElysiaApplicationCarrier,
	ElysiaCarrierRequestAddress,
} from './elysia-application-carrier'

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
	private readonly runtimeSessions = new Set<RuntimeSessionIngress>()

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
			for (const session of this.runtimeSessions) session.close()
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

	private async fetchIngress(request: Request, env?: unknown, ctx?: unknown): Promise<Response> {
		const url = new URL(request.url)
		const path = url.pathname
		const method = request.method.toUpperCase()
		const facts = this.requestFacts(request)
		if (path === RUNTIME_SESSION_PATH) {
			return await this.fetchRuntimeSession(request, facts.local, facts.secure)
		}

		if (this.config.management && isAdminAccessHandoffPath(path)) {
			const adminAccess = this.hostCtx.root.adminAccess
			if (!adminAccess) throw new Error('[pluxel/runtime] Management entry requires adminAccess')
			return await adminAccess.handleEntryRequest(request, facts.local, facts.secure)
		}

		if (!this.isProtectedArtifactPath(path)) return await this.fetchPtr(request, env, ctx)
		const adminAccess = this.hostCtx.root.adminAccess
		if (!adminAccess) throw new Error('[pluxel/runtime] Management request requires adminAccess')
		const admission = await adminAccess.admit(request, facts.local, facts.secure)
		if (admission.state.allow === false) {
			return this.buildArtifactAccessDeniedResponse(path, method, admission.state.reason)
		}

		const admittedRequest = requestWithSignal(request, admission.signal)
		try {
			const response = await this.fetchPtr(admittedRequest, env, ctx)
			return admission.state.method === 'provider'
				? responseWithLease(response, {
						signal: admission.signal,
						dispose: admission.release,
					})
				: response
		} catch (error) {
			admission.release()
			throw error
		}
	}

	private async fetchRuntimeSession(
		request: Request,
		local: boolean,
		secure: boolean,
	): Promise<Response> {
		const noStore = { 'cache-control': 'no-store' }
		if (!this.config.management) {
			return new Response('Not Found', { status: 404, headers: noStore })
		}
		if (!matchesRuntimeSessionUpgrade(request)) {
			return new Response('This endpoint only accepts a WebSocket upgrade.', {
				status: 400,
				headers: noStore,
			})
		}
		if ((!local && !secure) || !validateRuntimeSessionOrigin(request, secure)) {
			return new Response('Runtime session ingress rejected.', {
				status: 403,
				headers: noStore,
			})
		}
		const carrier = this.applicationCarrier
		const adminAccess = this.hostCtx.root.adminAccess
		if (!carrier || !adminAccess) {
			return new Response('Runtime session carrier unavailable.', {
				status: 503,
				headers: noStore,
			})
		}

		let ingress!: RuntimeSessionIngress
		ingress = new RuntimeSessionIngress({
			ctx: this.hostCtx,
			adminAccess,
			request,
			local,
			secure,
			workbench: this.config.workbench,
			onRelease: () => this.runtimeSessions.delete(ingress),
		})
		this.runtimeSessions.add(ingress)
		const accepted = carrier.upgrade(
			Object.freeze({
				request,
				upgradeRequest: request,
				ownerKey: 'pluxel.runtime.control',
				data: ingress.data,
				signal: ingress.signal,
				release: () => ingress.release(),
			}),
		)
		if (!accepted) {
			ingress.release()
			return new Response('Runtime session upgrade unavailable.', {
				status: 503,
				headers: noStore,
			})
		}
		return new Response(null, { status: 204, headers: noStore })
	}

	private isProtectedArtifactPath(path: string): boolean {
		if (!this.config.management || !this.config.workbench) return false
		const base = `${RUNTIME_INTERNAL_API_BASE}${RUNTIME_WORKBENCH_FEDERATION_BASE}`
		return path === base || path.startsWith(`${base}/`)
	}

	private requestFacts(request: Request): Readonly<{ local: boolean; secure: boolean }> {
		let address: ElysiaCarrierRequestAddress | null = null
		try {
			address = this.applicationCarrier
				? this.applicationCarrier.requestIP(request)
				: (this.requestAddress?.(request) ?? null)
		} catch {
			address = null
		}
		let secure = false
		try {
			if (this.applicationCarrier) {
				const metadata = this.applicationCarrier.metadata
				secure = metadata.url.protocol === 'https:'
			} else {
				const url = new URL(request.url)
				secure = url.protocol === 'https:'
			}
		} catch {
			secure = false
		}
		return Object.freeze({ local: isLoopbackAddress(address?.address), secure })
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

	private buildArtifactAccessDeniedResponse(
		path: string,
		method: string,
		reason: AdminAccessReason,
	): Response {
		this.logger.warn('Blocked immutable Workbench artifact request', { path, method, reason })
		const status =
			reason === 'authentication_unavailable'
				? 503
				: reason === 'secure_transport_required' || reason === 'forbidden'
					? 403
					: 401
		return Response.json(
			{ code: 'artifact_access_denied', reason },
			{
				status,
				headers: { 'cache-control': 'no-store' },
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

function requestWithSignal(request: Request, signal: AbortSignal): Request {
	if (request.signal === signal) return request
	const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
	return new Request(request.url, {
		method: request.method,
		headers: request.headers,
		body: hasBody ? request.body : undefined,
		signal,
		...(hasBody && request.body ? { duplex: 'half' } : {}),
	} as RequestInit)
}

/** Socket-peer loopback check. Host and forwarding headers are deliberately irrelevant. */
export function isLoopbackAddress(input: string | undefined): boolean {
	if (!input) return false
	let address = input.trim().toLowerCase()
	if (!address) return false
	if (address.startsWith('[') && address.endsWith(']')) address = address.slice(1, -1)
	address = address.split('%', 1)[0] ?? ''
	const ipv4 = address.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
	if (ipv4) {
		const octets = ipv4.slice(1).map(Number)
		return octets.every((octet) => octet >= 0 && octet <= 255) && octets[0] === 127
	}
	if (address === '::1' || address === '0:0:0:0:0:0:0:1') return true
	const mappedIpv4 = address.match(/^(?:::ffff:|0:0:0:0:0:ffff:)(\d+\.\d+\.\d+\.\d+)$/)
	if (mappedIpv4) return isLoopbackAddress(mappedIpv4[1])
	const mappedHex = address.match(/^(?:::ffff:|0:0:0:0:0:ffff:)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
	if (!mappedHex) return false
	const high = Number.parseInt(mappedHex[1]!, 16)
	const low = Number.parseInt(mappedHex[2]!, 16)
	return high >= 0 && high <= 0xffff && low >= 0 && low <= 0xffff && high >>> 8 === 0x7f
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
