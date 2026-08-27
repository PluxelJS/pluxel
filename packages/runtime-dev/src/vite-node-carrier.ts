import { posix } from 'node:path'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Server as SrvxServer } from 'srvx'
import { serve } from 'srvx/node'
import type { ResolvedConfig, ViteDevServer } from 'vite'
import {
	NodeElysiaApplicationCarrier,
	type NodeElysiaApplicationCarrierOptions,
} from '@pluxel/runtime-node'

type FetchHandler = (request: Request) => Response | Promise<Response>

export interface ViteBusinessWebSocketUpgrade {
	matches(request: IncomingMessage): boolean
	handle(request: IncomingMessage, socket: Duplex, head: Buffer): void | Promise<void>
}

export interface SrvxViteNodeCarrierOptions {
	fetch: FetchHandler
	shouldHandle?: (request: IncomingMessage) => boolean
	injectViteClientScript?: boolean
	businessWebSocket?: ViteBusinessWebSocketUpgrade
}

export interface SrvxViteNodeCarrierAttachment {
	close(): Promise<void>
}

export type ViteNodeElysiaApplicationCarrierOptions = Pick<
	NodeElysiaApplicationCarrierOptions,
	'fetch' | 'matches'
>

/** Creates the one Node/Elysia application carrier shared by a Vite business listener. */
export function createViteNodeElysiaApplicationCarrier(
	server: ViteDevServer,
	options: ViteNodeElysiaApplicationCarrierOptions,
): NodeElysiaApplicationCarrier {
	return new NodeElysiaApplicationCarrier({
		...options,
		metadata: () => viteCarrierMetadata(server),
	})
}

/**
 * Attaches a Fetch dispatcher to Vite's listener through srvx's public Node handler.
 *
 * Vite retains its listener, middleware fallthrough, assets, and exact HMR upgrade path. The
 * optional business WebSocket bridge only receives non-HMR upgrades selected by its own matcher.
 */
export function attachSrvxViteNodeCarrier(
	server: ViteDevServer,
	options: SrvxViteNodeCarrierOptions,
): SrvxViteNodeCarrierAttachment {
	const carrier = serve({
		manual: true,
		silent: true,
		gracefulShutdown: false,
		error(error) {
			const err = error instanceof Error ? error : new Error(String(error))
			server.ssrFixStacktrace(err)
			server.config.logger.error('[runtime-dev/vite] srvx request failed', { error: err })
			return new Response('Internal Server Error', { status: 500 })
		},
		async fetch(request) {
			const response = await options.fetch(request)
			return options.injectViteClientScript && isHtmlResponse(response)
				? withInjectedViteClient(response, server.config.base || '/')
				: response
		},
	})
	const handler = requireSrvxNodeHandler(carrier)
	const detachUpgrade = attachBusinessWebSocketUpgrade(
		server,
		server.config,
		options.businessWebSocket,
	)
	let closed = false
	const close = async () => {
		if (closed) return
		closed = true
		detachUpgrade()
		await carrier.close(true)
	}
	server.httpServer?.once('close', () => {
		void close()
	})
	server.middlewares.use((request, response, next) => {
		if (options.shouldHandle && !options.shouldHandle(request)) {
			next()
			return
		}
		void handler(request, response)
	})

	return Object.freeze({ close })
}

function isHtmlResponse(response: Response) {
	return (response.headers.get('content-type') ?? '').toLowerCase().startsWith('text/html')
}

function withInjectedViteClient(response: Response, base: string): Response {
	if (!response.body) return response
	const clientUrl = base === '/' ? '/@vite/client' : `${base.replace(/\/$/, '')}/@vite/client`
	const nonce = response.headers.get('content-security-policy')?.match(/'nonce-([^']+)'/)?.[1]
	const snippet = `<script${nonce ? ` nonce="${nonce}"` : ''}>import("${clientUrl}")</script>`
	const extra = new TextEncoder().encode(snippet)
	const body = response.body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				controller.enqueue(chunk)
			},
			flush(controller) {
				controller.enqueue(extra)
			},
		}),
	)

	const headers = new Headers(response.headers)
	headers.delete('content-length')
	return new Response(body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	})
}

function requireSrvxNodeHandler(carrier: SrvxServer) {
	const handler = carrier.node?.handler
	if (!handler) throw new Error('[runtime-dev/vite] srvx did not provide its public Node handler')
	return handler
}

function attachBusinessWebSocketUpgrade(
	server: ViteDevServer,
	config: ResolvedConfig,
	upgrade: ViteBusinessWebSocketUpgrade | undefined,
): () => void {
	const httpServer = server.httpServer
	if (!upgrade) return () => undefined
	if (!httpServer) {
		throw new Error(
			'[runtime-dev/vite] business WebSocket routes require a Vite-owned HTTP server; middleware mode has no upgrade listener to attach',
		)
	}

	const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
		try {
			if (isViteHmrUpgrade(request, httpServer, config)) return
			if (!upgrade.matches(request)) return
			const result = upgrade.handle(request, socket, head)
			void Promise.resolve(result).catch((error) => handleUpgradeError(server, socket, error))
		} catch (error) {
			handleUpgradeError(server, socket, error)
		}
	}

	httpServer.on('upgrade', onUpgrade)
	return () => httpServer.off('upgrade', onUpgrade)
}

function isViteHmrUpgrade(
	request: IncomingMessage,
	httpServer: NonNullable<ViteDevServer['httpServer']>,
	config: ResolvedConfig,
): boolean {
	const protocol = request.headers['sec-websocket-protocol']
	if (protocol !== 'vite-hmr' && protocol !== 'vite-ping') return false
	if (config.server.hmr === false) return false

	const hmr = typeof config.server.hmr === 'object' ? config.server.hmr : undefined
	const hmrUsesHttpServer = hmr?.server
		? hmr.server === httpServer
		: !hmr?.port || hmr.port === config.server.port
	if (!hmrUsesHttpServer) return false

	const pathname = new URL(request.url ?? '/', 'http://vite.invalid').pathname
	const hmrPath = hmr?.path ? posix.join(config.base || '/', hmr.path) : config.base || '/'
	return pathname === hmrPath
}

function handleUpgradeError(server: ViteDevServer, socket: Duplex, error: unknown): void {
	const err = error instanceof Error ? error : new Error(String(error))
	server.ssrFixStacktrace(err)
	server.config.logger.error('[runtime-dev/vite] business WebSocket upgrade failed', {
		error: err,
	})
	socket.destroy()
}

function viteCarrierMetadata(server: ViteDevServer) {
	const resolvedUrl = server.resolvedUrls?.local[0] ?? server.resolvedUrls?.network[0]
	if (resolvedUrl) {
		const url = new URL(resolvedUrl)
		return Object.freeze({
			url,
			port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
			hostname: url.hostname,
			development: true,
		})
	}

	const address = server.httpServer?.address()
	const configuredHost = server.config.server.host
	const hostname =
		typeof address === 'object' && address?.address
			? normalizeListenerHostname(address.address, configuredHost)
			: typeof configuredHost === 'string' && configuredHost
				? configuredHost
				: configuredHost === true
					? '0.0.0.0'
					: 'localhost'
	const port =
		typeof address === 'object' && address?.port
			? address.port
			: (server.config.server.port ?? 5173)
	const protocol = server.config.server.https ? 'https:' : 'http:'
	const url = new URL(`${protocol}//${urlHostname(hostname)}:${port}/`)
	return Object.freeze({ url, port, hostname, development: true })
}

function normalizeListenerHostname(address: string, configuredHost: string | boolean | undefined) {
	if (address !== '::' && address !== '0.0.0.0') return address
	if (typeof configuredHost === 'string' && configuredHost) return configuredHost
	return address
}

function urlHostname(hostname: string): string {
	return hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname
}
