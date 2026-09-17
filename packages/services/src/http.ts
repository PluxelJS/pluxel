import type { RootContext } from '@pluxel/core'
import type { Elysia } from 'elysia'
import {
	defineContextCapability,
	enterOwnerInvocation,
	installRootCapability,
	installScopeCapability,
	resolveContextCapability,
} from '@pluxel/core/host'
import { defineHostService } from '@pluxel/host'
import { ElysiaApplicationDirectory } from './http/ElysiaApplicationDirectory'
import { HttpDirectory } from './http/internal'
import type { ElysiaApplicationCarrier } from './http/elysia-application-carrier'

export type {
	ElysiaApplicationCarrier,
	ElysiaCarrierMetadata,
	ElysiaCarrierRequestAddress,
	ElysiaWebSocketUpgrade,
} from './http/elysia-application-carrier'

/** Native Elysia application owned by one Plugin generation and shared with its Parts. */
export const Http = defineContextCapability<Elysia>('services.http', {
	access: 'owner',
	property: 'elysia',
})

/** A Host-owned fixed path boundary. Requests under the prefix never fall through to Plugin routes. */
export interface HostHttpEndpoint {
	readonly prefix: string
	fetch(request: Request, carrier: ElysiaApplicationCarrier | undefined): Promise<Response>
	matchesWebSocketRoute(request: Request): boolean
}

/** Host-only business request boundary. A physical carrier is separately owned and attached by the host. */
export interface HostHttpFallback {
	fetch(request: Request): Promise<Response | null>
	matchesRequest(request: Request): boolean
}

export interface HttpServerApi {
	matchesRequest(request: Request): boolean
	fetch(request: Request): Promise<Response>
	matchesWebSocketRoute(request: Request): boolean
	attachApplicationCarrier(carrier: ElysiaApplicationCarrier): () => void
	mountEndpoint(endpoint: HostHttpEndpoint): () => void
	/** One Host shell fallback, after business route dispatch misses. */
	mountFallback(fallback: HostHttpFallback): () => void
}
export const HttpServer = defineContextCapability<HttpServerApi>('services.http.server', {
	access: 'root',
})

declare module '@pluxel/core' {
	interface ContextServices {
		readonly elysia?: Elysia
	}
}

/** Install business HTTP without management, Workbench or a physical listener. */
export function http() {
	return defineHostService({
		name: 'HTTP',
		capabilities: [
			installRootCapability(HttpDirectory, { create: () => new ElysiaApplicationDirectory() }),
			installScopeCapability(Http, {
				property: 'elysia',
				create: (ctx) => resolveContextCapability(ctx.root, HttpDirectory).applicationFor(ctx),
			}),
			installRootCapability(HttpServer, {
				create: (ctx) => new HostHttpServer(ctx, resolveContextCapability(ctx, HttpDirectory)),
			}),
		],
		prepare: ({ ctx, effects }) => {
			effects.defer(() => (resolveContextCapability(ctx, HttpServer) as HostHttpServer).close(), {
				tag: 'HostHttpEndpoints',
				phase: 'shutdown',
			})
		},
		lifecycle: (ctx) => resolveContextCapability(ctx, HttpDirectory).lifecycleHooks,
	})
}

class HostHttpServer implements HttpServerApi {
	private readonly endpoints = new Set<HostHttpEndpoint>()
	private carrier?: ElysiaApplicationCarrier
	private fallback?: HostHttpFallback
	private closed = false
	constructor(
		private readonly ctx: RootContext,
		private readonly directory: ElysiaApplicationDirectory,
	) {}
	fetch = async (request: Request): Promise<Response> => {
		if (this.closed) return new Response('Service Unavailable', { status: 503 })
		const endpoint = this.select(request)
		if (endpoint) {
			let lease
			try {
				lease = enterOwnerInvocation(this.ctx, request.signal)
			} catch {
				return new Response('Service Unavailable', { status: 503 })
			}
			try {
				return await endpoint.fetch(request, this.carrier)
			} finally {
				lease.dispose()
			}
		}
		const business = await this.directory.dispatch(request)
		if (business) return business
		if (this.fallback) {
			let lease
			try {
				lease = enterOwnerInvocation(this.ctx, request.signal)
			} catch {
				return new Response('Service Unavailable', { status: 503 })
			}
			try {
				const response = await this.fallback.fetch(new Request(request, { signal: lease.signal }))
				if (response) return response
			} finally {
				lease.dispose()
			}
		}
		return new Response('Not Found', { status: 404 })
	}
	matchesRequest = (request: Request): boolean => {
		if (this.closed) return false
		return (
			!!this.select(request) ||
			this.directory.matchesHttpRoute(new URL(request.url).pathname, request.method) ||
			!!this.fallback?.matchesRequest(request)
		)
	}
	matchesWebSocketRoute = (request: Request): boolean => {
		if (this.closed) return false
		const endpoint = this.select(request)
		return endpoint
			? endpoint.matchesWebSocketRoute(request)
			: this.directory.matchesWebSocketRoute(request)
	}
	attachApplicationCarrier = (carrier: ElysiaApplicationCarrier): (() => void) => {
		this.assertOpen()
		const detach = this.directory.attachApplicationCarrier(carrier)
		this.carrier = carrier
		return () => {
			detach()
			if (this.carrier === carrier) this.carrier = undefined
		}
	}
	mountEndpoint = (endpoint: HostHttpEndpoint): (() => void) => {
		this.assertOpen()
		const prefix = endpoint.prefix
		if (
			!/^\/(?:[^/?#]+\/)*[^/?#]+$/.test(prefix) ||
			new URL(prefix, 'http://host.invalid').pathname !== prefix
		)
			throw new TypeError(
				'Host HTTP endpoint prefix must be a normalized absolute path without a trailing slash',
			)
		for (const existing of this.endpoints)
			if (matchesPrefix(existing.prefix, prefix) || matchesPrefix(prefix, existing.prefix))
				throw new Error('Host HTTP endpoint prefixes must not overlap')
		const mounted = Object.freeze({
			prefix,
			fetch: endpoint.fetch.bind(endpoint),
			matchesWebSocketRoute: endpoint.matchesWebSocketRoute.bind(endpoint),
		})
		this.endpoints.add(mounted)
		return () => {
			this.endpoints.delete(mounted)
		}
	}
	mountFallback = (fallback: HostHttpFallback): (() => void) => {
		this.assertOpen()
		if (this.fallback) throw new Error('A Host HTTP fallback is already mounted')
		this.fallback = fallback
		let active = true
		return () => {
			if (!active) return
			active = false
			if (this.fallback === fallback) this.fallback = undefined
		}
	}
	close(): void {
		this.closed = true
		this.endpoints.clear()
		this.fallback = undefined
		this.carrier = undefined
	}
	private assertOpen(): void {
		if (this.closed) throw new Error('Host HTTP server is closed')
	}
	private select(request: Request): HostHttpEndpoint | undefined {
		const pathname = new URL(request.url).pathname
		for (const endpoint of this.endpoints)
			if (matchesPrefix(pathname, endpoint.prefix)) return endpoint
		return undefined
	}
}
function matchesPrefix(pathname: string, prefix: string): boolean {
	return pathname === prefix || pathname.startsWith(prefix + '/')
}
