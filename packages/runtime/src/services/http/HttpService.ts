import type { Context as PluxelContext } from '@pluxel/core'
import { resolveContextCapability } from '@pluxel/core/host'
import {
	HttpServer,
	type HttpServerApi,
	type ElysiaApplicationCarrier,
	type ElysiaCarrierRequestAddress,
} from '@pluxel/services/http'
import { requireHttpDirectory } from '@pluxel/services/internal/http'
import { attachManagementHttp } from '@pluxel/management/internal/http'
import { requireWorkbench, createWorkbenchArtifactHandler } from '@pluxel/workbench/server'
import type { RenderHandler } from '@pluxel/workbench/internal/shell'
import { createWorkbenchShellHandler } from '@pluxel/workbench/shell'
import { matchesWorkbenchUiBasePath, normalizeWorkbenchUiBasePath } from '../../workbench-config'

type HttpHandler = (request: Request, env?: unknown, ctx?: unknown) => Response | Promise<Response>
type RuntimeHttpUiAssetMode = 'dev-server' | 'static-built' | 'disabled'
export type RuntimeHttpAssetConfig = Readonly<{
	uiAssets?: RuntimeHttpUiAssetMode
	uiPublicDir?: string
}>
export type RuntimeHttpHostConfig = RuntimeHttpAssetConfig &
	Readonly<{
		management: boolean
		workbench: boolean
		uiBasePath: string
		/** @internal Isolated test-only peer seam; physical carrier facts always take precedence. */
		requestAddress?: (request: Request) => ElysiaCarrierRequestAddress | null
	}>

/** Legacy product facade over the selected Host's single HTTP boundary. */
export class HttpService {
	readonly #server: HttpServerApi
	readonly #config: {
		management: boolean
		workbench: boolean
		uiAssets: RuntimeHttpUiAssetMode
		uiPublicDir: string
		uiBasePath: string
	}
	#fullReloadRequested = false
	#shell?: Promise<(request: Request) => Promise<Response | null>>

	private constructor(
		public readonly ctx: PluxelContext,
		config: RuntimeHttpHostConfig,
	) {
		this.#server = resolveContextCapability(ctx, HttpServer)
		this.#config = {
			management: config.management,
			workbench: config.workbench,
			uiAssets: config.workbench ? (config.uiAssets ?? 'static-built') : 'disabled',
			uiPublicDir: config.uiPublicDir ?? '',
			uiBasePath: normalizeWorkbenchUiBasePath(config.uiBasePath),
		}
		if (config.management) {
			const requestAddress = config.requestAddress
			attachManagementHttp(
				ctx.root,
				ctx.effects,
				config.workbench
					? {
							bindings: () => ({
								artifacts: createWorkbenchArtifactHandler(ctx),
								createWorkbench: (principal, identity) =>
									requireWorkbench(ctx).createSession(principal, identity),
							}),
						}
					: {},
				requestAddress
					? {
							requestPeer: (request) => {
								const url = new URL(request.url)
								return {
									address: requestAddress(request)?.address,
									secure: url.protocol === 'https:',
									origin: url.origin,
								}
							},
						}
					: {},
			)
		}
		if (config.workbench) {
			const unmount = this.#server.mountFallback({
				fetch: async (request) => (await (this.#shell ??= this.createShell()))(request),
				matchesRequest: (request) =>
					this.#config.uiAssets !== 'disabled' &&
					this.matchesWorkbenchUiRoute(new URL(request.url).pathname),
			})
			ctx.effects.defer(unmount, { tag: 'RuntimeWorkbenchShell', phase: 'shutdown' })
		}
		Object.freeze(this)
	}

	static createRoot(ctx: PluxelContext, config: RuntimeHttpHostConfig): HttpService {
		return new HttpService(ctx, config)
	}
	get fetch(): HttpHandler {
		return this.#server.fetch
	}
	attachApplicationCarrier(carrier: ElysiaApplicationCarrier): () => void {
		return this.#server.attachApplicationCarrier(carrier)
	}
	matchesWebSocketRoute(request: Request): boolean {
		return this.#server.matchesWebSocketRoute(request)
	}
	matchesMountedRoute(pathname: string): boolean {
		return (
			requireHttpDirectory(this.ctx.root).matchesHttpRoute(pathname) ||
			(this.#config.management &&
				(pathname === '/__pluxel/runtime' || pathname.startsWith('/__pluxel/runtime/')))
		)
	}
	matchesWorkbenchUiRoute(pathname: string): boolean {
		return this.#config.workbench && matchesWorkbenchUiBasePath(pathname, this.#config.uiBasePath)
	}
	workbenchOwnsRootNavigation(): boolean {
		return this.#config.workbench && this.#config.uiBasePath === '/'
	}
	workbenchUiBasePath(): string | undefined {
		return this.#config.workbench ? this.#config.uiBasePath : undefined
	}
	consumeFullReloadRequest(): boolean {
		const value = this.#fullReloadRequested
		this.#fullReloadRequested = false
		return value
	}
	reconfigureUiAssets(config: {
		uiAssets?: RuntimeHttpUiAssetMode
		uiPublicDir?: string
		uiBasePath?: string
	}): void {
		const uiAssets = config.uiAssets ?? 'static-built'
		const uiPublicDir = config.uiPublicDir ?? ''
		const uiBasePath =
			config.uiBasePath === undefined
				? this.#config.uiBasePath
				: normalizeWorkbenchUiBasePath(config.uiBasePath)
		if (
			uiAssets === this.#config.uiAssets &&
			uiPublicDir === this.#config.uiPublicDir &&
			uiBasePath === this.#config.uiBasePath
		)
			return
		Object.assign(this.#config, { uiAssets, uiPublicDir, uiBasePath })
		this.#shell = undefined
		this.#fullReloadRequested = true
	}
	private async createShell(): Promise<(request: Request) => Promise<Response | null>> {
		const config = this.#config
		if (config.uiAssets === 'disabled') return async () => null
		if (config.uiAssets === 'static-built')
			return createWorkbenchShellHandler({
				publicDir: config.uiPublicDir || undefined,
				uiBasePath: config.uiBasePath,
			})
		const { createHmrRenderer } = await import('@pluxel/workbench/internal/shell')
		const render: RenderHandler = await createHmrRenderer({ uiBasePath: config.uiBasePath })
		return async (request) => {
			if (
				!this.matchesWorkbenchUiRoute(new URL(request.url).pathname) ||
				(request.method !== 'GET' && request.method !== 'HEAD')
			)
				return null
			const mode = request.headers.get('sec-fetch-mode')
			const destination = request.headers.get('sec-fetch-dest')
			if (
				(mode && mode !== 'navigate') ||
				(destination && destination !== 'document' && destination !== 'iframe')
			)
				return null
			const accept = (request.headers.get('accept') ?? '').toLowerCase()
			if (!accept.includes('text/html') && !accept.includes('*/*')) return null
			const response = await render(request)
			return request.method === 'HEAD'
				? new Response(null, { status: response.status, headers: response.headers })
				: response
		}
	}
}
export { isLoopbackAddress } from '@pluxel/management/internal/web/session/endpoint'
