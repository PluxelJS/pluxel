import { responseWithLease } from '../../services/admin-access/response-lifetime'
import { RUNTIME_INTERNAL_API_BASE, RUNTIME_WORKBENCH_FEDERATION_BASE } from '../paths'
import type { AdminAccessService } from '../../services/admin-access/AdminAccessService'
import { isAdminAccessHandoffPath } from '../../services/admin-access/transport'
import {
	matchesRuntimeSessionUpgrade,
	RuntimeSessionIngress,
	validateRuntimeSessionOrigin,
} from './ingress'
import type { RuntimeSessionFactories } from './server'
import { RUNTIME_SESSION_PATH } from './protocol'

/** Facts supplied by the carrier, never inferred from client Host/Forwarded headers. */
export type ManagementPeer = Readonly<{
	address?: string
	secure?: boolean
	origin?: string
}>

export type ManagementEndpointOptions = RuntimeSessionFactories &
	Readonly<{
		authentication: Pick<AdminAccessService, 'openSession' | 'handleEntryRequest'> &
			Partial<Pick<AdminAccessService, 'admit'>>
		/** Borrowed Workbench artifact handler, authorized through the same management authentication. */
		artifacts?(request: Request): Promise<Response | undefined>
	}>

export type ManagementConnection = Pick<
	RuntimeSessionIngress,
	'signal' | 'open' | 'receive' | 'transportClosed' | 'close' | 'release'
>

export type ManagementUpgrade = Readonly<
	{ accepted: false; response: Response } | { accepted: true; connection: ManagementConnection }
>

/** Owns control connections, while borrowing authentication and the Host's management operations. */
export class ManagementEndpoint implements Disposable {
	private readonly connections = new Set<RuntimeSessionIngress>()
	private closed = false
	private readonly scope = new AbortController()
	constructor(private readonly options: ManagementEndpointOptions) {
		if (options.artifacts && !options.authentication.admit)
			throw new TypeError('Workbench artifacts require authentication admission')
	}

	async fetch(request: Request, peer: ManagementPeer = {}): Promise<Response | null> {
		const path = new URL(request.url).pathname
		const artifactBase = RUNTIME_INTERNAL_API_BASE + RUNTIME_WORKBENCH_FEDERATION_BASE
		const artifact =
			!!this.options.artifacts && (path === artifactBase || path.startsWith(artifactBase + '/'))
		if (path !== RUNTIME_SESSION_PATH && !isAdminAccessHandoffPath(path) && !artifact) return null
		if (this.closed) return unavailable()
		if (artifact) return this.fetchArtifact(request, peer)
		if (path === RUNTIME_SESSION_PATH)
			return new Response('This endpoint requires a carrier WebSocket upgrade.', {
				status: 400,
				headers: noStore,
			})
		return this.options.authentication.handleEntryRequest(
			new Request(request, { signal: AbortSignal.any([request.signal, this.scope.signal]) }),
			localPeer(peer),
			peer.secure === true,
		)
	}

	private async fetchArtifact(request: Request, peer: ManagementPeer): Promise<Response> {
		const scoped = new Request(request, {
			signal: AbortSignal.any([request.signal, this.scope.signal]),
		})
		const admission = await this.options.authentication.admit!(
			scoped,
			localPeer(peer),
			peer.secure === true,
		)
		if (admission.state.allow === false) {
			const reason = admission.state.reason
			const status =
				reason === 'authentication_unavailable'
					? 503
					: reason === 'secure_transport_required' || reason === 'forbidden'
						? 403
						: 401
			return Response.json({ code: 'artifact_access_denied', reason }, { status, headers: noStore })
		}
		try {
			const response = await this.options.artifacts!(
				new Request(request, { signal: admission.signal }),
			)
			if (!response) {
				admission.release()
				return new Response('Not Found', { status: 404, headers: noStore })
			}
			if (admission.state.method === 'provider')
				return responseWithLease(response, { signal: admission.signal, dispose: admission.release })
			admission.release()
			return response
		} catch (error) {
			admission.release()
			throw error
		}
	}

	/** Validate first, then let the carrier upgrade and pass the accepted socket to connection.open(). */
	prepareUpgrade(request: Request, peer: ManagementPeer = {}): ManagementUpgrade {
		if (this.closed) return { accepted: false, response: unavailable() }
		if (!matchesRuntimeSessionUpgrade(request))
			return {
				accepted: false,
				response: new Response('This endpoint only accepts a WebSocket upgrade.', {
					status: 400,
					headers: noStore,
				}),
			}
		const local = localPeer(peer)
		const secure = peer.secure === true
		if ((!local && !secure) || !trustedOrigin(request, peer, secure)) {
			return {
				accepted: false,
				response: new Response('Runtime session ingress rejected.', {
					status: 403,
					headers: noStore,
				}),
			}
		}
		let ingress!: RuntimeSessionIngress
		ingress = new RuntimeSessionIngress({
			...this.options,
			adminAccess: this.options.authentication,
			request,
			local,
			secure,
			onRelease: () => this.connections.delete(ingress),
		})
		this.connections.add(ingress)
		return { accepted: true, connection: ingress }
	}

	close(): void {
		if (this.closed) return
		this.closed = true
		this.scope.abort(new Error('Management endpoint is closed'))
		for (const connection of this.connections) {
			connection.close()
			connection.release()
		}
		this.connections.clear()
	}

	[Symbol.dispose](): void {
		this.close()
	}
}

export function createManagementEndpoint(options: ManagementEndpointOptions): ManagementEndpoint {
	return new ManagementEndpoint(options)
}

const noStore = { 'cache-control': 'no-store' }
function unavailable(): Response {
	return new Response('Management endpoint is closed.', { status: 503, headers: noStore })
}
function localPeer(peer: ManagementPeer): boolean {
	return isLoopbackAddress(peer.address)
}
function trustedOrigin(request: Request, peer: ManagementPeer, secure: boolean): boolean {
	if (!peer.origin) return false
	try {
		const origin = new URL(peer.origin)
		if (
			origin.origin !== peer.origin ||
			(origin.protocol !== 'https:' && origin.protocol !== 'http:')
		)
			return false
		const headers = new Headers(request.headers)
		headers.set('host', origin.host)
		return (
			validateRuntimeSessionOrigin(
				new Request(request.url, { method: request.method, headers }),
				secure,
			) && new URL(headers.get('origin')!).origin === origin.origin
		)
	} catch {
		return false
	}
}

/** Socket-peer loopback check. Host and forwarding headers are deliberately irrelevant. */
export function isLoopbackAddress(input: string | undefined): boolean {
	if (!input) return false
	let address = input.trim().toLowerCase()
	if (!address) return false
	if (address.startsWith('[') && address.endsWith(']')) address = address.slice(1, -1)
	address = address.split('%', 1)[0] ?? ''
	const ipv4 = address.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
	if (ipv4) {
		const octets = ipv4.slice(1).map(Number)
		return octets.every((octet) => octet >= 0 && octet <= 255) && octets[0] === 127
	}
	if (address === '::1' || address === '0:0:0:0:0:0:0:1') return true
	const mappedIpv4 = address.match(/^(?:::ffff:|0:0:0:0:0:ffff:)(\d+\.\d+\.\d+\.\d+)$/)
	if (mappedIpv4) return isLoopbackAddress(mappedIpv4[1])
	const mappedHex = address.match(/^(?:::ffff:|0:0:0:0:0:ffff:)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
	if (!mappedHex) return false
	const high = Number.parseInt(mappedHex[1]!, 16)
	const low = Number.parseInt(mappedHex[2]!, 16)
	return high >= 0 && high <= 0xffff && low >= 0 && low <= 0xffff && high >>> 8 === 0x7f
}
