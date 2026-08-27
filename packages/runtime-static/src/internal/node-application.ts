import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { IncomingMessage, Server as NodeHttpServer } from 'node:http'
import { extname, isAbsolute, relative, resolve as resolvePath } from 'node:path'
import { Readable, type Duplex } from 'node:stream'
import { serve } from 'srvx/node'
import type { ServerRequest } from 'srvx'
import type { PluginConstructor } from '@pluxel/core'
import type { ProductDescriptor } from '@pluxel/runtime/product'
import { runStaticFetchApplication, type StaticFetchApplicationOptions } from './fetch-application'
import type { WorkbenchBackendFactory } from '@pluxel/runtime/internal/static'
import { requireRuntimeHttpService } from '@pluxel/runtime/internal'
import type {
	StaticRuntime,
	StaticRuntimeApplication,
	StaticRuntimeBindings,
	StaticRuntimeEnvironment,
} from '../types'
import { NodeElysiaApplicationCarrier } from '@pluxel/runtime-node'

export type StaticNodeApplication = StaticRuntime & {
	readonly address: { host: string; port: number }
}

export async function runStaticNodeApplication<
	TBindings extends StaticRuntimeBindings = StaticRuntimeBindings,
>(
	application: StaticRuntimeApplication<readonly PluginConstructor[], TBindings>,
	options: StaticFetchApplicationOptions<TBindings> & {
		createWorkbenchBackend?: WorkbenchBackendFactory
		product?: ProductDescriptor | null
	},
): Promise<StaticNodeApplication> {
	const env = options.env ?? readProcessEnvironment()
	const runtime = await runStaticFetchApplication(application, { ...options, env })
	const http = requireRuntimeHttpService(runtime.ctx)
	const host = env.PLUXEL_HOST_BIND?.trim() || '127.0.0.1'
	const port = parsePort(env.PLUXEL_HOST_PORT, 3000)
	let carrier!: ReturnType<typeof serve>
	const applicationCarrier = new NodeElysiaApplicationCarrier({
		fetch: (request) => runtime.fetch(request),
		matches: (request) => http.matchesWebSocketRoute(request),
		metadata: () => {
			if (!carrier.url) {
				throw new Error('[runtime-static] srvx Node carrier metadata is unavailable before ready')
			}
			const url = new URL(carrier.url)
			return Object.freeze({
				url,
				port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
				hostname: url.hostname,
				development: false,
			})
		},
	})
	const detachApplicationCarrier = http.attachApplicationCarrier(applicationCarrier)
	carrier = serve({
		manual: true,
		hostname: host,
		port,
		silent: true,
		gracefulShutdown: false,
		fetch: (request) =>
			dispatch(runtime, request, {
				applicationPublicDir: `${options.deployment.root}/public`,
				serveApplicationPublic:
					options.deployment.variant === 'headless' || !http.workbenchOwnsRootNavigation(),
				applicationCarrier,
			}),
	})
	const nodeServer = carrier.node?.server as NodeHttpServer | undefined
	if (!nodeServer) {
		detachApplicationCarrier()
		await applicationCarrier.close().catch((): undefined => undefined)
		await runtime.stop().catch((): undefined => undefined)
		throw new Error('[runtime-static] srvx Node carrier did not expose an upgrade listener')
	}
	const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) =>
		applicationCarrier.handleUpgrade(request, socket, head)
	nodeServer.on('upgrade', onUpgrade)
	try {
		await carrier.serve()
		await carrier.ready()
	} catch (error) {
		nodeServer.off('upgrade', onUpgrade)
		detachApplicationCarrier()
		await applicationCarrier.close().catch((): undefined => undefined)
		await carrier.close(true).catch((): undefined => undefined)
		await runtime.stop().catch((): undefined => undefined)
		throw error
	}
	const actualPort = Number(new URL(carrier.url).port || port)
	let stopPromise: Promise<void> | undefined
	const stop = () => {
		stopPromise ??= (async () => {
			process.off('SIGINT', onSignal)
			process.off('SIGTERM', onSignal)
			applicationCarrier.stopAccepting()
			let runtimeError: unknown
			try {
				await runtime.stop()
			} catch (error) {
				runtimeError = error
			}
			detachApplicationCarrier()
			nodeServer.off('upgrade', onUpgrade)
			let websocketError: unknown
			try {
				await applicationCarrier.close()
			} catch (error) {
				websocketError = error
			}
			let listenerError: unknown
			try {
				await carrier.close(true)
			} catch (error) {
				listenerError = error
			}
			const errors = [runtimeError, websocketError, listenerError].filter(
				(error) => error !== undefined,
			)
			if (errors.length === 1) throw errors[0]
			if (errors.length > 1) {
				throw new AggregateError(errors, '[runtime-static] Node carrier shutdown failed')
			}
		})()
		return stopPromise
	}
	const onSignal = () => {
		void stop().then(
			() => process.exit(0),
			() => process.exit(1),
		)
	}
	process.once('SIGINT', onSignal)
	process.once('SIGTERM', onSignal)

	return {
		...runtime,
		address: { host, port: actualPort },
		stop,
	}
}

async function dispatch(
	runtime: StaticRuntime,
	request: Request,
	options: {
		applicationPublicDir: string
		serveApplicationPublic: boolean
		applicationCarrier: NodeElysiaApplicationCarrier
	},
): Promise<Response> {
	const client = new AbortController()
	bindClientDisconnect(request, client)
	const signal = AbortSignal.any([request.signal, client.signal])
	const input = requestWithSignal(request, signal)
	options.applicationCarrier.bindRequest(input, request)
	try {
		const result = await runtime.fetch(input)
		const applicationAsset =
			result.status === 404 && options.serveApplicationPublic
				? await resolveApplicationAsset(input, options.applicationPublicDir)
				: null
		return applicationAsset ?? result
	} catch (error) {
		if (signal.aborted) throw error
		return new Response('Internal server error', { status: 500 })
	}
}

function requestWithSignal(request: Request, signal: AbortSignal): Request {
	const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
	return new Request(request.url, {
		method: request.method,
		headers: request.headers,
		signal,
		body: hasBody ? request.body : undefined,
		...(hasBody && request.body ? { duplex: 'half' } : {}),
	} as RequestInit)
}

function bindClientDisconnect(request: Request, client: AbortController): void {
	const response = (request as ServerRequest).runtime?.node?.res
	if (!response) return
	const cleanup = () => {
		response.off('close', onClose)
		response.off('finish', cleanup)
	}
	const onClose = () => {
		if (!response.writableEnded) {
			client.abort(new DOMException('Client disconnected', 'AbortError'))
		}
		cleanup()
	}
	response.once('close', onClose)
	response.once('finish', cleanup)
}

async function resolveApplicationAsset(
	request: Request,
	publicDir: string,
): Promise<Response | null> {
	if (request.method !== 'GET' && request.method !== 'HEAD') return null
	let pathname: string
	try {
		pathname = decodeURIComponent(new URL(request.url).pathname)
	} catch {
		return null
	}
	const relativePath = pathname.replace(/^\/+/, '')
	const direct = relativePath
		? resolvePath(publicDir, relativePath)
		: resolvePath(publicDir, 'index.html')
	const directAsset = await toApplicationAssetResponse(request, publicDir, direct)
	if (directAsset) return directAsset
	if (!request.headers.get('accept')?.toLowerCase().includes('text/html')) return null
	return toApplicationAssetResponse(request, publicDir, resolvePath(publicDir, 'index.html'))
}

async function toApplicationAssetResponse(
	request: Request,
	publicDir: string,
	path: string,
): Promise<Response | null> {
	const relativePath = relative(publicDir, path)
	if (relativePath.startsWith('..') || isAbsolute(relativePath)) return null
	const fileStat = await stat(path).catch((): null => null)
	if (!fileStat?.isFile()) return null
	const headers = new Headers({
		'content-length': String(fileStat.size),
		'content-type': applicationContentType(path),
	})
	if (request.method === 'HEAD') return new Response(null, { status: 200, headers })
	return new Response(Readable.toWeb(createReadStream(path)) as unknown as BodyInit, {
		status: 200,
		headers,
	})
}

function applicationContentType(path: string): string {
	switch (extname(path).toLowerCase()) {
		case '.html':
			return 'text/html; charset=utf-8'
		case '.css':
			return 'text/css; charset=utf-8'
		case '.js':
		case '.mjs':
			return 'application/javascript; charset=utf-8'
		case '.json':
			return 'application/json; charset=utf-8'
		case '.svg':
			return 'image/svg+xml'
		case '.png':
			return 'image/png'
		case '.jpg':
		case '.jpeg':
			return 'image/jpeg'
		case '.webp':
			return 'image/webp'
		case '.woff2':
			return 'font/woff2'
		default:
			return 'application/octet-stream'
	}
}

function readProcessEnvironment(): StaticRuntimeEnvironment {
	return process.env
}

function parsePort(value: string | undefined, fallback: number): number {
	if (value === undefined || value.trim() === '') return fallback
	const port = Number(value)
	if (!Number.isInteger(port) || port < 0 || port > 65_535) {
		throw new Error(`[runtime-static] Invalid PLUXEL_HOST_PORT: ${value}`)
	}
	return port
}
