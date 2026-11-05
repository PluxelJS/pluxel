import type { Server as NodeHttpServer, IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { resolve } from 'node:path'
import { serve } from 'srvx/node'
import type { ServerOptions } from 'srvx'
import { dispatchElysiaRequest } from './dispatch'
import type { PluginHost } from '@pluxel/host'
import {
	enterOwnerInvocation,
	resolveContextCapability,
	type OwnerInvocationLease,
} from '@pluxel/core/host'
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
		/** Optional public directory, resolved against cwd and served only for unmatched, non-reserved requests. */
		publicDir?: string
		/** Trusted public HTTP(S) origin supplied by the listener owner. */
		publicOrigin?: string
	}
>

/** Start srvx under the Host's effects. Host close(), listener close() and process signals share shutdown. */
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
	const { publicDir: inputPublicDir, publicOrigin: inputPublicOrigin, ...serverOptions } = options
	const http = resolveContextCapability(host.ctx, ElysiaRuntime)
	const hostname = serverOptions.hostname ?? '0.0.0.0'
	const port = serverOptions.port ?? 3000
	const publicOrigin = resolvePublicOrigin(inputPublicOrigin)
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
				publicOrigin,
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
	let startup: OwnerInvocationLease | undefined
	let owned = false
	const stopAccepting = () => carrier.stopAccepting()
	let disposing: Promise<void> | undefined
	const dispose = (): Promise<void> =>
		(disposing ??= (async () => {
			process.off('SIGINT', signal)
			process.off('SIGTERM', signal)
			startup?.signal.removeEventListener('abort', stopAccepting)
			stopAccepting()
			const failures: unknown[] = []
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
	const close = (): Promise<void> => host.close()
	const signal = () => {
		void close().catch((error) => {
			process.exitCode = 1
			console.error(error)
		})
	}
	try {
		// Startup participates in root admission until the listener has settled. The
		// signal keeps rejecting ingress after that lease is released, before effects drain.
		startup = enterOwnerInvocation(host.ctx)
		const ownerSignal = startup.signal
		ownerSignal.addEventListener('abort', stopAccepting, { once: true })
		host.ctx.effects.defer(dispose, { tag: 'ElysiaListener', phase: 'shutdown' })
		owned = true
		server = serve({
			...serverOptions,
			manual: true,
			hostname,
			port,
			silent: serverOptions.silent ?? true,
			gracefulShutdown: false,
			fetch: (request) =>
				ownerSignal.aborted
					? new Response('Service Unavailable', { status: 503 })
					: dispatchElysiaRequest(request, http.dispatch, carrier, publicDir),
		})
		node = server.node?.server as NodeHttpServer | undefined
		if (!node) throw new Error('[host] HTTP listener has no Node server')
		node.on('upgrade', upgrade)
		await server.serve()
		await server.ready()
		startup.signal.throwIfAborted()
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
		// close() first drains root admission; never wait for it while holding this lease.
		startup?.dispose()
		const [cleanup] = await Promise.allSettled([owned ? close() : dispose()])
		if (cleanup.status === 'rejected')
			throw new AggregateError([error, cleanup.reason], '[host] HTTP startup and cleanup failed', {
				cause: error,
			})
		throw error
	} finally {
		startup?.dispose()
	}
}

function resolvePublicOrigin(input: string | undefined): string | undefined {
	if (input === undefined) return undefined
	let url: URL
	try {
		if (typeof input !== 'string') throw new TypeError('expected a string')
		url = new URL(input)
	} catch (cause) {
		throw new TypeError('[host] publicOrigin must be an HTTP(S) origin', { cause })
	}
	if (
		!['http:', 'https:'].includes(url.protocol) ||
		url.username ||
		url.password ||
		url.pathname !== '/' ||
		url.search ||
		url.hash
	) {
		throw new TypeError('[host] publicOrigin must be an HTTP(S) origin')
	}
	return url.origin
}
