import type { Server as NodeHttpServer, IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { resolve } from 'node:path'
import { serve } from 'srvx/node'
import type { ServerOptions } from 'srvx'
import { dispatchElysiaRequest } from './dispatch'
import type { PluginHost } from '@pluxel/host'
import { resolveHostEnv } from '@pluxel/host/environment'
import { resolveContextCapability } from '@pluxel/core/host'
import { ElysiaRuntime } from './runtime'
import { NodeElysiaApplicationCarrier } from './node'

/** Native srvx TCP listener options; the Host owns dispatch and shutdown. */
export type ListenElysiaOptions = Readonly<
	Omit<ServerOptions, 'fetch' | 'manual' | 'gracefulShutdown'> & {
		/** Native Node HTTP/TLS and TCP options. IPC transports can use createElysiaHandler() with srvx directly. */
		node?: {
			path?: never
			handle?: never
			fd?: never
		}
		/** Optional public directory, resolved against cwd and served after a non-reserved 404. */
		publicDir?: string
	}
>

/** Start the prepared Host on srvx. close() drains the Host and closes its listener; also handles SIGINT/SIGTERM. */
export async function listenElysia(host: PluginHost, options: ListenElysiaOptions = {}) {
	if (!options || typeof options !== 'object' || Array.isArray(options))
		throw new TypeError('[host] listener options must be an object')
	for (const key of ['fetch', 'manual', 'gracefulShutdown'])
		if (Object.hasOwn(options, key))
			throw new TypeError(`[host] listenElysia owns ${key}; use srvx directly for custom ownership`)
	for (const key of ['path', 'handle', 'fd'])
		if (
			options.node &&
			key in options.node &&
			options.node[key as keyof typeof options.node] !== undefined
		)
			throw new TypeError(
				'[host] listenElysia requires TCP; use createElysiaHandler with srvx for IPC transports',
			)
	const { publicDir: inputPublicDir, ...serverOptions } = options
	const http = resolveContextCapability(host.ctx, ElysiaRuntime)
	const environment = resolveHostEnv()
	const hostname = serverOptions.hostname ?? environment.hostBind ?? '0.0.0.0'
	const port = serverOptions.port ?? environment.hostPort ?? 3000
	if (
		inputPublicDir !== undefined &&
		(typeof inputPublicDir !== 'string' || !inputPublicDir.trim() || inputPublicDir.includes('\0'))
	)
		throw new TypeError('[host] publicDir must be a non-empty directory path')
	const publicDir = inputPublicDir === undefined ? undefined : resolve(inputPublicDir)
	let server: ReturnType<typeof serve> | undefined
	const carrier = new NodeElysiaApplicationCarrier({
		fetch: http.fetch,
		matches: http.matchesWebSocketRoute,
		metadata() {
			const address = node?.address()
			if (!server?.url || !address || typeof address === 'string')
				throw new Error('[host] HTTP listener is not ready')
			const url = new URL(server.url)
			return {
				url,
				publicOrigin: environment.publicOrigin,
				hostname: url.hostname,
				port: address.port,
				development: false,
			}
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
			...serverOptions,
			manual: true,
			hostname,
			port,
			silent: serverOptions.silent ?? true,
			gracefulShutdown: false,
			fetch: (request) => dispatchElysiaRequest(request, http.fetch, carrier, publicDir),
		})
		node = server.node?.server as NodeHttpServer | undefined
		if (!node) throw new Error('[host] HTTP listener has no Node server')
		node.on('upgrade', upgrade)
		await server.serve()
		await server.ready()
		process.once('SIGINT', signal)
		process.once('SIGTERM', signal)
		const url = new URL(server.url)
		const address = node.address()
		if (!address || typeof address === 'string')
			throw new Error('[host] HTTP listener has no TCP address')
		return Object.freeze({
			address: Object.freeze({ host: url.hostname, port: address.port }),
			close,
		})
	} catch (error) {
		const [cleanup] = await Promise.allSettled([close()])
		if (cleanup.status === 'rejected')
			throw new AggregateError([error, cleanup.reason], '[host] HTTP startup and cleanup failed', {
				cause: error,
			})
		throw error
	}
}
