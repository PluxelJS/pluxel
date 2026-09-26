import type { RootContext } from '@pluxel/core'
import { defineContextCapability, enterOwnerInvocation } from '@pluxel/core/host'
import type { ElysiaApplicationDirectory } from './ElysiaApplicationDirectory'
import type { ElysiaApplicationCarrier } from './elysia-application-carrier'
import { requestWithSignal } from './request'

/** A Host-owned fixed path boundary. Requests under the prefix never fall through to Plugin routes. */
export interface ElysiaEndpoint {
	readonly prefix: string
	fetch(request: Request, carrier: ElysiaApplicationCarrier | undefined): Promise<Response>
	matchesWebSocketRoute(request: Request): boolean
}

/** Host-only business request boundary. A physical carrier is separately owned and attached by the host. */
export interface ElysiaFallback {
	fetch(request: Request): Promise<Response | null>
	matchesRequest(request: Request): boolean
}

export interface ElysiaRuntimeApi {
	matchesRequest(request: Request): boolean
	fetch(request: Request): Promise<Response>
	matchesWebSocketRoute(request: Request): boolean
	attachApplicationCarrier(carrier: ElysiaApplicationCarrier): () => void
	mountEndpoint(endpoint: ElysiaEndpoint): () => void
	/** One Host shell fallback, after business route dispatch misses. */
	mountFallback(fallback: ElysiaFallback): () => void
}
export const ElysiaRuntime = defineContextCapability<ElysiaRuntimeApi>('services.elysia.runtime', {
	access: 'root',
})

export class HostElysiaRuntime implements ElysiaRuntimeApi {
	private readonly endpoints = new Set<ElysiaEndpoint>()
	private carrier?: ElysiaApplicationCarrier
	private fallback?: ElysiaFallback
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
				const scopedRequest = requestWithSignal(request, lease.signal)
				const carrier = this.carrier
				// Carrier state is keyed by ingress identity, not by the signal-bearing view.
				const scopedCarrier: ElysiaApplicationCarrier | undefined = carrier && {
					metadata: carrier.metadata,
					requestIP: (input) => carrier.requestIP(input === scopedRequest ? request : input),
					upgrade: (input) =>
						carrier.upgrade({
							...input,
							request: input.request === scopedRequest ? request : input.request,
						}),
					publish: (...args) => carrier.publish(...args),
					pending: (owner) => carrier.pending(owner),
				}
				return await endpoint.fetch(scopedRequest, scopedCarrier)
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
				const response = await this.fallback.fetch(requestWithSignal(request, lease.signal))
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
	mountEndpoint = (endpoint: ElysiaEndpoint): (() => void) => {
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
	mountFallback = (fallback: ElysiaFallback): (() => void) => {
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
	private select(request: Request): ElysiaEndpoint | undefined {
		const pathname = new URL(request.url).pathname
		for (const endpoint of this.endpoints)
			if (matchesPrefix(pathname, endpoint.prefix)) return endpoint
		return undefined
	}
}
function matchesPrefix(pathname: string, prefix: string): boolean {
	return pathname === prefix || pathname.startsWith(prefix + '/')
}
