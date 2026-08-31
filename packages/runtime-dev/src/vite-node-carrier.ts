import { posix } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Server as SrvxServer } from 'srvx'
import { serve } from 'srvx/node'
import type { ResolvedConfig, ViteDevServer } from 'vite'
import {
	NodeElysiaApplicationCarrier,
	type NodeElysiaApplicationCarrierOptions,
} from '../../runtime-node/src/index.ts'

type FetchHandler = (request: Request) => Response | Promise<Response>

export interface ViteBusinessWebSocketUpgrade {
	matches(request: IncomingMessage): boolean
	handle(request: IncomingMessage, socket: Duplex, head: Buffer): void | Promise<void>
}

export interface SrvxViteNodeCarrierOptions {
	fetch: FetchHandler
	shouldHandle?: (request: IncomingMessage) => boolean
	transformViteHtml?: boolean
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
 * Vite retains its listener, middleware fallthrough, assets, and exact HMR upgrade path. Optional
 * HTML transformation runs the complete Vite index pipeline selected by the host. The optional
 * business WebSocket bridge only receives non-HMR upgrades selected by its own matcher.
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
			return options.transformViteHtml && isHtmlResponse(response)
				? transformViteHtmlResponse(server, request, response)
				: response
		},
	})
	const handler = requireSrvxNodeHandler(carrier)
	const detachUpgrade = attachBusinessWebSocketUpgrade(
		server,
		server.config,
		options.businessWebSocket,
	)
	const close = createSrvxViteNodeCarrierClose(detachUpgrade, () => carrier.close(true))
	server.httpServer?.once('close', () => {
		void close().catch((cause) =>
			reportViteCarrierError(server, 'srvx carrier close failed', cause),
		)
	})
	server.middlewares.use((request, response, next) => {
		if (options.shouldHandle && !options.shouldHandle(request)) {
			next()
			return
		}
		dispatchSrvxViteNodeRequest(server, handler, request, response)
	})

	return Object.freeze({ close })
}

type SrvxNodeHandler = (
	request: IncomingMessage,
	response: ServerResponse,
) => void | PromiseLike<void>

/** @internal Observes the async Node handler boundary used by Vite's callback middleware. */
export function dispatchSrvxViteNodeRequest(
	server: ViteDevServer,
	handler: SrvxNodeHandler,
	request: IncomingMessage,
	response: ServerResponse,
): void {
	let result: void | PromiseLike<void>
	try {
		result = handler(request, response)
	} catch (cause) {
		handleViteNodeRequestFailure(server, request, response, cause)
		return
	}
	if (!result) return
	void Promise.resolve(result).catch((cause) =>
		handleViteNodeRequestFailure(server, request, response, cause),
	)
}

/** @internal Shares one close result across the HTTP close event and Vite's close hook. */
export function createSrvxViteNodeCarrierClose(
	detachUpgrade: () => void,
	closeCarrier: () => void | PromiseLike<void>,
): () => Promise<void> {
	let closePromise: Promise<void> | undefined
	return () => {
		closePromise ??= Promise.resolve()
			.then(() => {
				detachUpgrade()
				return closeCarrier()
			})
			.catch((cause: unknown) => {
				throw viteCarrierError('srvx carrier close failed', cause)
			})
		return closePromise
	}
}

function handleViteNodeRequestFailure(
	server: ViteDevServer,
	request: IncomingMessage,
	response: ServerResponse,
	cause: unknown,
): void {
	if (isExpectedNodeRequestTermination(request, response, cause)) return
	reportViteCarrierError(server, 'srvx request dispatch failed', cause)
	if (response.destroyed || response.writableEnded) return
	try {
		if (response.headersSent) {
			response.destroy()
			return
		}
		response.statusCode = 500
		response.statusMessage = ''
		response.end()
	} catch {
		response.destroy()
	}
}

function isExpectedNodeRequestTermination(
	request: IncomingMessage,
	response: ServerResponse,
	cause: unknown,
): boolean {
	if (request.aborted || request.destroyed || response.destroyed) return true
	if (!(cause instanceof Error)) return false
	return (
		cause.name === 'AbortError' ||
		(cause as NodeJS.ErrnoException).code === 'ERR_STREAM_PREMATURE_CLOSE'
	)
}

function reportViteCarrierError(server: ViteDevServer, context: string, cause: unknown): void {
	const error = viteCarrierError(context, cause)
	try {
		server.ssrFixStacktrace(error)
		server.config.logger.error(`[runtime-dev/vite] ${context}`, { error })
	} catch {
		// This is the terminal Promise observation boundary. A diagnostic adapter failure must not
		// recreate the unhandled rejection that this boundary exists to contain.
	}
}

function viteCarrierError(context: string, cause: unknown): Error {
	if (cause instanceof Error) return cause
	const detail = cause === undefined ? 'without a rejection reason' : `with ${String(cause)}`
	return new Error(`[runtime-dev/vite] ${context} ${detail}`, { cause })
}

function isHtmlResponse(response: Response) {
	return (response.headers.get('content-type') ?? '').toLowerCase().startsWith('text/html')
}

async function transformViteHtmlResponse(
	server: ViteDevServer,
	request: Request,
	response: Response,
): Promise<Response> {
	if (!response.body) return response
	const url = new URL(request.url)
	const originalUrl = `${url.pathname}${url.search}`
	const html = await server.transformIndexHtml(url.pathname, await response.text(), originalUrl)
	const headers = new Headers(response.headers)
	headers.delete('content-length')
	return new Response(html, {
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
