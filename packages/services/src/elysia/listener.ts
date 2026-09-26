import { requestWithSignal } from './request'
import type { Server as NodeHttpServer, IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { serve } from 'srvx/node'
import { resolveApplicationAsset } from './assets'
import type { PluginHost } from '@pluxel/host'
import { resolveHostEnv } from '@pluxel/host/environment'
import { resolveContextCapability } from '@pluxel/core/host'
import { ElysiaRuntime } from './runtime'
import { NodeElysiaApplicationCarrier } from './node'

/** Start the prepared Host on srvx. close() drains the Host and closes its listener; also handles SIGINT/SIGTERM. */
export async function listenElysia(
	host: PluginHost,
	options: Readonly<{
		/** Overrides PLUXEL_HOST_BIND / Portless HOST; defaults to 0.0.0.0. */
		hostname?: string
		/** Overrides PLUXEL_HOST_PORT / Portless PORT; defaults to 3000. Zero selects a free port. */
		port?: number
		/** Optional application public directory, served only after a non-reserved 404. */
		publicDir?: string
	}> = {},
) {
	const http = resolveContextCapability(host.ctx, ElysiaRuntime)
	const environment = resolveHostEnv()
	const hostname = options.hostname ?? environment.hostBind ?? '0.0.0.0'
	const port = options.port ?? environment.hostPort ?? 3000
	if (!Number.isInteger(port) || port < 0 || port > 65535)
		throw new TypeError('[host] port must be an integer from 0 to 65535')
	let server: ReturnType<typeof serve> | undefined
	const carrier = new NodeElysiaApplicationCarrier({
		fetch: http.fetch,
		matches: http.matchesWebSocketRoute,
		metadata() {
			if (!server?.url) throw new Error('[host] HTTP listener is not ready')
			const url = new URL(server.url)
			return { url, hostname: url.hostname, port: Number(url.port || 80), development: false }
		},
	})
	const detach = http.attachApplicationCarrier(carrier)
	let node: NodeHttpServer | undefined
	const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) =>
		carrier.handleUpgrade(request, socket, head)
	let closing: Promise<void> | undefined
	const close = (): Promise<void> =>
		(closing ??= (async () => {
			process.off('SIGINT', signal)
			process.off('SIGTERM', signal)
			carrier.stopAccepting()
			const failures: unknown[] = []
			try {
				await host.close()
			} catch (error) {
				failures.push(error)
			}
			try {
				await carrier.close()
			} catch (error) {
				failures.push(error)
			}
			detach()
			node?.off('upgrade', upgrade)
			try {
				await server?.close(true)
			} catch (error) {
				failures.push(error)
			}
			if (failures.length > 0) throw new AggregateError(failures, '[host] HTTP shutdown failed')
		})())
	const signal = () => {
		void close().catch((error) => {
			process.exitCode = 1
			console.error(error)
		})
	}
	try {
		server = serve({
			manual: true,
			hostname,
			port,
			silent: true,
			gracefulShutdown: false,
			fetch: (request) => dispatch(request, http.fetch, carrier, options.publicDir),
		})
		node = server.node?.server as NodeHttpServer | undefined
		if (!node) throw new Error('[host] HTTP listener has no Node server')
		node.on('upgrade', upgrade)
		await server.serve()
		await server.ready()
		process.once('SIGINT', signal)
		process.once('SIGTERM', signal)
		const url = new URL(server.url)
		return Object.freeze({
			address: Object.freeze({ host: url.hostname, port: Number(url.port || 80) }),
			close,
		})
	} catch (error) {
		try {
			await close()
		} catch (cleanup) {
			throw new AggregateError([error, cleanup], '[host] HTTP startup and cleanup failed', {
				cause: cleanup,
			})
		}
		throw error
	}
}

async function dispatch(
	request: Request,
	fetch: (request: Request) => Response | Promise<Response>,
	carrier: NodeElysiaApplicationCarrier,
	publicDir?: string,
): Promise<Response> {
	// srvx propagates premature response closure through the ingress request signal.
	const input = requestWithSignal(request, request.signal)
	carrier.bindRequest(input, request)
	const result = await fetch(input)
	const pathname = new URL(input.url).pathname
	if (
		publicDir &&
		result.status === 404 &&
		pathname !== '/__pluxel' &&
		!pathname.startsWith('/__pluxel/')
	) {
		return (await resolveApplicationAsset(input, publicDir)) ?? result
	}
	return result
}
