import { type Context, Injectable } from '@pluxel/core'
import { HMR_INTERNAL_API_BASE } from '@pluxel/hmr-web'
import { Elysia } from 'elysia'
import type { Plugin } from 'vite'

import { ensureHmrPluginLevelsLoaded } from '../../logger/levels'
import type { RenderHandler } from '../../server/types'
import { UI_PUBLIC_MOUNT_RE } from '../../server/ui-public'
import type { SseChannel } from '../plugin-interaction'
import type { ExtensionManifestEvent } from '../runtime-compile'
import type { AuthGuardContext, AuthGuardKind, AuthGuardResult } from './AuthGuardService'
import { createElysiaApp, type AnyElysiaApp, type CreateElysiaAppOptions } from './elysia'
import { createInternalApiRoutes } from './internalApi'
import { createFetchDevServerPlugin } from './vite-fetch-plugin'

const serviceName = 'http' as const

declare module '@pluxel/core' {
	namespace Context {
		interface Services {
			[serviceName]: HttpService
		}
	}
}

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

function encodePathSegment(input: string): string {
	return encodeURIComponent(input)
}

@Injectable({ key: serviceName })
export class HttpService {
	private shouldReload = false
	private readonly mounted = new Map<string, MountedBoundary>()
	private mountedIndex: MountedBoundary[] = []
	private fetchPtr: HttpHandler = async () =>
		new Response('HTTP runtime unavailable', { status: 503 })

	private readonly logger: NonNullable<Context['logger']>
	private renderer: Promise<RenderHandler> | null = null
	private sseBuiltinsReady = false

	constructor(public ctx: Context) {
		this.logger = ctx.logger!
		this.rebuildRootApp()
		this.host.routes(createInternalApiRoutes(this.ctx), {
			id: 'hmr:internal-api',
			path: HMR_INTERNAL_API_BASE,
			app: {
				aot: true,
				name: 'pluxel.http.internal',
			},
		})
		this.registerSseBuiltins()

		void ensureHmrPluginLevelsLoaded(ctx).catch((error) => {
			this.logger.warn('Failed to load persisted plugin log levels', { error })
		})
	}

	get fetch() {
		return this.fetchPtr
	}

	get plugin() {
		const pluginId = this.requirePluginId()
		const elysia = (options?: CreateElysiaAppOptions) => this.createApp(options)
		return {
			id: pluginId,
			// Advanced escape hatch. Prefer `routes()` for normal Elysia route trees so
			// callers follow Elysia's chaining model and can replace mounted trees safely.
			elysia,
			app: elysia,
			base: (path = '/') => this.resolvePluginBase(pluginId, path),
			routes: (build: ElysiaBoundaryBuilder, options: PluginHttpMountOptions = {}) =>
				this.mountPluginRoutes(pluginId, build, options),
			mount: (boundary: HttpBoundary, options: PluginHttpMountOptions = {}) =>
				this.mountPluginBoundary(pluginId, boundary, options),
		}
	}

	get host() {
		const elysia = (options?: CreateElysiaAppOptions) => this.createApp(options)
		return {
			// Advanced escape hatch. Prefer `routes()` for normal Elysia route trees.
			elysia,
			app: elysia,
			routes: (build: ElysiaBoundaryBuilder, options: HostHttpRouteOptions) =>
				this.mountHostRoutes(build, options),
			mount: (spec: HostHttpMountSpec) => this.mountHostBoundary(spec),
		}
	}

	get vitePlugin(): Plugin {
		return createFetchDevServerPlugin({
			exclude: [
				/^\/@.+$/,
				/^\/node_modules\/.*/,
				UI_PUBLIC_MOUNT_RE,
				/(\.ts|\.tsx)(\?.*)?$/,
				/^\/favicon\.ico$/,
				/^\/static\/.+/,
				/\?t=\d+$/,
			],
			fetch: (req) => this.fetch(req),
			handleHotUpdate: ({ server }) => {
				if (this.shouldReload) {
					this.shouldReload = false
					server.ws.send({ type: 'full-reload' })
				}
				return []
			},
		})
	}

	private mountHostBoundary(spec: HostHttpMountSpec): HttpBoundaryHandle {
		return this.mountAtPath({
			id: spec.id,
			base: spec.path,
			boundary: spec.boundary,
		})
	}

	private mountPluginBoundary(
		pluginId: string,
		boundary: HttpBoundary,
		options: PluginHttpMountOptions = {},
	): HttpBoundaryHandle {
		const path = normalizePluginPath(options.path)
		const routeId = options.id ?? this.defaultPluginBoundaryId(pluginId, path)
		return this.mountHostBoundary({
			id: routeId,
			path: this.resolvePluginBase(pluginId, path),
			boundary,
		})
	}

	private mountPluginRoutes(
		pluginId: string,
		build: ElysiaBoundaryBuilder,
		options: PluginHttpMountOptions = {},
	): ElysiaRouteHandle {
		const { app: appOptions, ...mountOptions } = options
		const createBoundary = (nextBuild: ElysiaBoundaryBuilder) =>
			nextBuild(this.createApp(appOptions))
		const handle = this.mountPluginBoundary(pluginId, createBoundary(build), mountOptions)

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
			nextBuild(this.createApp(appOptions))
		const handle = this.mountHostBoundary({
			...mountSpec,
			boundary: createBoundary(build),
		})

		return {
			...handle,
			replaceRoutes: (nextBuild) => handle.replace(createBoundary(nextBuild)),
		}
	}

	private mountAtPath(spec: MountedBoundarySpec): HttpBoundaryHandle {
		const slot = this.upsertMounted(spec)
		const dispose = () => {
			if (this.mounted.delete(slot.id)) {
				this.refreshMountedIndex()
				this.rebuildRootApp()
				this.requestFullReload()
			}
		}
		const guard = this.ctx.effects.defer(dispose)

		return {
			replace: (boundary) => {
				this.upsertMounted({ ...spec, boundary })
				this.requestFullReload()
			},
			dispose: () => guard.dispose(),
		}
	}

	private rebuildRootApp() {
		const root = createElysiaApp(this.ctx, {
			aot: true,
			name: 'pluxel.http.root',
		})

		for (const slot of this.mountedIndex) slot.install(root)

		const fallback = async ({ request }: { request: Request }) => {
			const url = new URL(request.url)
			const path = url.pathname
			const method = (request.method ?? 'GET').toUpperCase()

			if (this.isHtmlNavigation(request)) {
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

	private registerSseBuiltins() {
		if (this.sseBuiltinsReady) return
		this.sseBuiltinsReady = true

		const disposers = [
			this.registerBuiltinSse('extensions', (channel) => this.streamManifestEvents(channel)),
		]

		for (const dispose of disposers) this.ctx.effects.defer(dispose)
	}

	private registerBuiltinSse(
		namespace: string,
		handler: (channel: SseChannel) => undefined | (() => void),
	) {
		return this.ctx.ext.sse.registerExtension(() => handler, { namespace })
	}

	private streamManifestEvents(channel: SseChannel): undefined | (() => void) {
		const service = this.ctx.ext.ui
		if (!service) {
			channel.emit('error', { reason: 'Extension service unavailable' })
			return undefined
		}

		channel.emit('ready', { type: 'ready' })
		channel.emit('sync', { type: 'sync', version: service.getManifest().version })

		const send = (event: ExtensionManifestEvent) => channel.emit(event.type, event)
		const unsubscribe = service.subscribeManifest(send)
		channel.onAbort(unsubscribe)
		return () => unsubscribe()
	}

	private async guardUiRequest(
		request: Request,
		path: string,
		method: string,
		kind: AuthGuardKind,
	): Promise<Response | undefined> {
		const service = this.ctx.authGuard
		if (!service || !service.isActive()) return undefined

		const input: AuthGuardContext = {
			kind,
			path,
			method,
			headers: request.headers,
			request,
			url: request.url,
		}

		const result = await service.check(input)
		if (result.allow === true) return undefined
		const denied = result as Extract<AuthGuardResult, { allow: false }>

		this.logger.warn('Blocked request', { kind, path, method, pluginName: denied.pluginName })

		return this.buildAuthDeniedResponse(path, method, kind, denied)
	}

	private buildAuthDeniedResponse(
		path: string,
		method: string,
		kind: AuthGuardKind,
		result: Extract<AuthGuardResult, { allow: false }>,
	): Response {
		if (kind === 'ui') {
			return new Response(null, {
				status: 302,
				headers: {
					Location: result.redirectPath,
					'Cache-Control': 'no-store',
				},
			})
		}

		return Response.json(
			{
				allow: false,
				code: 'access_denied',
				kind,
				path,
				method,
				pluginName: result.pluginName,
				redirectPath: result.redirectPath,
			},
			{
				status: 401,
				headers: {
					'Cache-Control': 'no-store',
					'X-Pluxel-Auth-Blocked': '1',
					'X-Pluxel-Redirect-Path': result.redirectPath,
				},
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
		return createElysiaApp(this.ctx, {
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

	private requirePluginId(): string {
		const pluginId = String(this.ctx.pluginInfo?.id ?? '').trim()
		if (!pluginId) throw new Error('Plugin-scoped HTTP routes require ctx.pluginInfo.id')
		return pluginId
	}

	private resolvePluginBase(pluginId: string, path = '/'): string {
		const suffix = normalizePluginPath(path)
		const base = `${PLUGIN_HTTP_BASE}/${encodePathSegment(pluginId)}`
		return suffix === '/' ? base : `${base}${suffix}`
	}

	private defaultPluginBoundaryId(pluginId: string, path: string): string {
		return path === '/'
			? `${pluginId}:http`
			: `${pluginId}:http:${path.slice(1).replace(/\//g, ':')}`
	}

	private requestFullReload() {
		this.shouldReload = true
	}

	private refreshMountedIndex() {
		this.mountedIndex = Array.from(this.mounted.values()).sort((a, b) => b.base.length - a.base.length)
	}

	private createApp(options?: CreateElysiaAppOptions) {
		return createElysiaApp(this.ctx, options)
	}

	private createRenderer(): Promise<RenderHandler> {
		// NOTE: SOURCE_ONLY preprocessor blocks are stripped by tsdown for non-source builds.
		// Do NOT remove them or rewrite this into runtime conditions.
		// #if SOURCE_ONLY
		return import('../../server/dev').then(({ createDevRenderer }) => createDevRenderer())
		// #else
		// biome-ignore lint/correctness/noUnreachable: SOURCE_ONLY preprocessor strips this branch at build time.
		return import('../../server/static').then(({ createStaticRenderer }) => {
			return createStaticRenderer()
		})
		// #endif
	}

	private async render(request: Request) {
		const handler = await (this.renderer ??= this.createRenderer())
		return handler(request)
	}
}
