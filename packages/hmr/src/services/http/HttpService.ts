import devServer from '@hono/vite-dev-server'
import { type Context, Injectable } from '@pluxel/core'
import { HMR_INTERNAL_API_BASE } from '@pluxel/hmr-web'
import type { Plugin } from 'vite'

import { ensureHmrPluginLevelsLoaded } from '../../logger/levels'
import type { RenderHandler } from '../../server/types'
import { UI_PUBLIC_MOUNT_RE } from '../../server/ui-public'
import type { SseChannel } from '../plugin-interaction'
import type { ExtensionManifestEvent } from '../runtime-compile'
import type { AuthGuardContext, AuthGuardKind, AuthGuardResult } from './AuthGuardService'
import { createHonoApp } from './hono'
import type { AppEnv, HonoWithAppEnvType } from './hono-env'
import { createInternalApiBoundary } from './internalApi'

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
	env?: any,
	ctx?: any,
) => Response | Promise<Response>

export type HttpBoundary = HttpHandler | { fetch: HttpHandler }

export interface HttpBoundarySpec {
	id: string
	base: string
	boundary: HttpBoundary
}

export interface HttpBoundaryHandle {
	replace(boundary: HttpBoundary): void
	dispose(): void
}

type MountedBoundary = {
	id: string
	base: string
	fetch: HttpHandler
}

function normalizeMountBase(base: string): string {
	const raw = base.trim()
	if (!raw || raw === '/') return '/'
	return raw.startsWith('/') ? raw.replace(/\/+$/, '') || '/' : `/${raw.replace(/\/+$/, '')}`
}

function pathMatchesBase(pathname: string, base: string): boolean {
	if (base === '/') return true
	return pathname === base || pathname.startsWith(`${base}/`)
}

@Injectable({ key: serviceName })
export class HttpService {
	private app!: HonoWithAppEnvType
	private shouldReload = false
	private readonly mounted = new Map<string, MountedBoundary>()
	private fetchPtr: HttpHandler = async () =>
		new Response('HTTP runtime unavailable', { status: 503 })

	private readonly logger: NonNullable<Context['logger']>
	private renderer: Promise<RenderHandler> | null = null
	private sseBuiltinsReady = false

	constructor(public ctx: Context) {
		this.logger = ctx.logger!
		this.rebuildRoot()
		this.mountBoundary({
			id: 'hmr:internal-api',
			base: HMR_INTERNAL_API_BASE,
			boundary: createInternalApiBoundary(this.hono.app()),
		})
		this.registerSseBuiltins()

		void ensureHmrPluginLevelsLoaded(ctx).catch((error) => {
			this.logger.warn('Failed to load persisted plugin log levels', { error })
		})
	}

	get fetch() {
		return this.fetchPtr
	}

	get hono() {
		return {
			app: () => createHonoApp(this.ctx),
		}
	}

	get vitePlugin(): Plugin {
		return devServer({
			exclude: [
				/^\/@.+$/,
				/^\/node_modules\/.*/,
				UI_PUBLIC_MOUNT_RE,
				/(\.ts|\.tsx)(\?.*)?$/,
				/^\/favicon\.ico$/,
				/^\/static\/.+/,
				/\?t=\d+$/,
			],
			loadModule: async () => ({ fetch: this.fetch }) as any,
			handleHotUpdate: ({ server }) => {
				if (this.shouldReload) {
					this.shouldReload = false
					server.ws.send({ type: 'full-reload' })
				}
				return []
			},
		})
	}

	mountBoundary(spec: HttpBoundarySpec): HttpBoundaryHandle {
		const slot = this.upsertMounted(spec)
		const dispose = () => {
			if (this.mounted.delete(slot.id)) this.requestFullReload()
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

	private rebuildRoot(): HonoWithAppEnvType {
		const app = createHonoApp(this.ctx)

		app.use('*', async (c, next) => this.dispatchMounted(c, next))

		app.use('*', async (c, next) => {
			if (!this.isHtmlNavigation(c)) return next()
			const denied = await this.guardUiRequest(c, 'ui')
			if (denied) return denied
			return this.render(c)
		})

		this.app = app
		this.updateFetchPtr()
		return this.app
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
		c: import('hono').Context<AppEnv>,
		kind: AuthGuardKind,
	): Promise<Response | undefined> {
		const service = this.ctx.authGuard
		if (!service || !service.isActive()) return undefined

		const request = c.req.raw
		const headers =
			request.headers instanceof Headers ? request.headers : new Headers(request.headers)
		const url = c.req.url
		const path = c.req.path
		const method = (request.method ?? c.req.method).toUpperCase()

		const input: AuthGuardContext = {
			kind,
			path,
			method,
			headers,
			request,
			url,
		}

		const result = await service.check(input)
		if (result.allow === true) return undefined
		const denied = result as Extract<AuthGuardResult, { allow: false }>

		this.logger.warn('Blocked request', { kind, path, method, pluginName: denied.pluginName })

		return this.buildAuthDeniedResponse(c, kind, denied)
	}

	private buildAuthDeniedResponse(
		c: import('hono').Context<AppEnv>,
		kind: AuthGuardKind,
		result: Extract<AuthGuardResult, { allow: false }>,
	): Response {
		if (kind === 'ui') {
			return c.redirect(result.redirectPath, 302)
		}

		return c.json(
			{
				allow: false,
				code: 'access_denied',
				kind,
				path: c.req.path,
				method: c.req.method,
				pluginName: result.pluginName,
				redirectPath: result.redirectPath,
			},
			401,
			{
				'Cache-Control': 'no-store',
				'X-Pluxel-Auth-Blocked': '1',
				'X-Pluxel-Redirect-Path': result.redirectPath,
			},
		)
	}

	private isHtmlNavigation(c: import('hono').Context<AppEnv>): boolean {
		const req = c.req.raw
		const headers = req.headers instanceof Headers ? req.headers : new Headers(req.headers)
		const method = (req.method ?? c.req.method).toUpperCase()
		if (method !== 'GET' && method !== 'HEAD') return false

		const accept = (headers.get('accept') ?? '').toLowerCase()
		if (!accept.includes('text/html') && !accept.includes('*/*')) return false

		const fetchMode = headers.get('sec-fetch-mode')
		if (fetchMode && fetchMode !== 'navigate') return false

		const fetchDest = headers.get('sec-fetch-dest')
		if (fetchDest && fetchDest !== 'document' && fetchDest !== 'iframe') return false

		return true
	}

	private dispatchMounted(
		c: import('hono').Context<AppEnv>,
		next: () => Promise<void>,
	): Promise<Response | void> | Response | void {
		const slot = this.resolveMounted(c.req.path)
		if (!slot) return next()
		return this.fetchMounted(slot, c)
	}

	private resolveMounted(pathname: string): MountedBoundary | undefined {
		let matched: MountedBoundary | undefined
		for (const slot of this.mounted.values()) {
			if (!pathMatchesBase(pathname, slot.base)) continue
			if (!matched || slot.base.length > matched.base.length) matched = slot
		}
		return matched
	}

	private async fetchMounted(
		slot: MountedBoundary,
		c: import('hono').Context<AppEnv>,
	): Promise<Response> {
		try {
			return await slot.fetch(this.rewriteMountedRequest(c.req.raw, slot.base))
		} catch (error) {
			this.logger.error('Mounted module request failed', {
				error,
				id: slot.id,
				base: slot.base,
				path: c.req.path,
				method: c.req.method,
			})
			return c.text('Internal server error', 500)
		}
	}

	private upsertMounted(spec: HttpBoundarySpec): MountedBoundary {
		const slot: MountedBoundary = {
			id: spec.id,
			base: normalizeMountBase(spec.base),
			fetch: this.toFetch(spec.boundary),
		}
		this.mounted.set(slot.id, slot)
		return slot
	}

	private toFetch(boundary: HttpBoundary): HttpHandler {
		if (typeof boundary === 'function') return boundary
		return boundary.fetch.bind(boundary)
	}

	private rewriteMountedRequest(req: Request, base: string): Request {
		if (base === '/') return req
		const url = new URL(req.url)
		const nextPath = url.pathname.slice(base.length) || '/'
		url.pathname = nextPath.startsWith('/') ? nextPath : `/${nextPath}`
		return new Request(url, req)
	}

	private updateFetchPtr() {
		const f = this.app.fetch.bind(this.app) as unknown as HttpHandler
		this.fetchPtr = (req, env, ctx) => f(req, env, ctx)
	}

	private requestFullReload() {
		this.shouldReload = true
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

	private async render(c: import('hono').Context<AppEnv>) {
		const handler = await (this.renderer ??= this.createRenderer())
		return handler(c)
	}
}
