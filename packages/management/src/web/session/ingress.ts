import type {
	AdminAccessService,
	AdminAuthenticationSession,
} from '../../services/admin-access/AdminAccessService'
import { RuntimeSessionServer, type RuntimeSessionFactories } from './server'
import { RuntimeSessionWebSocket, type ManagementSocket } from './elysia-websocket'
import { RUNTIME_SESSION_MAX_MESSAGE_BYTES } from './limits'
import { RUNTIME_SESSION_PATH } from './protocol'

const MAX_INITIALIZATION_MESSAGES = 32
const MAX_INITIALIZATION_BYTES = RUNTIME_SESSION_MAX_MESSAGE_BYTES

export type RuntimeSessionIngressOptions = RuntimeSessionFactories &
	Readonly<{
		adminAccess: Pick<AdminAccessService, 'openSession'>
		request: Request
		local: boolean
		secure: boolean
		onRelease(): void
	}>

/** One pending/active host-owned control upgrade. The physical carrier owns final release. */
export class RuntimeSessionIngress {
	private readonly controller = new AbortController()
	private socket?: RuntimeSessionWebSocket
	private server?: RuntimeSessionServer
	private pendingMessages: string[] = []
	private pendingMessageBytes = 0
	private released = false

	constructor(private readonly options: RuntimeSessionIngressOptions) {}

	get signal(): AbortSignal {
		return this.controller.signal
	}

	close(): void {
		if (this.released) return
		if (this.server) this.server.invalidate('service-restart')
		this.socket?.close(1012, 'Service Restart')
		this.controller.abort(new Error('Runtime session service restarted'))
	}

	release(): void {
		if (this.released) return
		this.released = true
		this.controller.abort(new Error('Runtime session carrier released'))
		this.socket?.closed(1006, 'Runtime session carrier released')
		this.server?.[Symbol.dispose]()
		this.server = undefined
		this.socket = undefined
		this.pendingMessages = []
		this.pendingMessageBytes = 0
		this.options.onRelease()
	}

	async open(rawSocket: ManagementSocket): Promise<void> {
		if (this.released || this.controller.signal.aborted) {
			rawSocket.close(1012, 'Runtime session ingress expired')
			return
		}
		const socket = new RuntimeSessionWebSocket(rawSocket, {
			maxMessageBytes: RUNTIME_SESSION_MAX_MESSAGE_BYTES,
		})
		this.socket = socket
		let authentication: AdminAuthenticationSession | undefined
		try {
			authentication = await this.options.adminAccess.openSession(
				requestWithSignal(this.options.request, this.controller.signal),
				this.options.local,
				this.options.secure,
			)
			if (this.released || this.controller.signal.aborted) {
				authentication.release()
				return
			}
			const ownedAuthentication = authentication
			authentication = undefined
			this.server = new RuntimeSessionServer({
				createManagement: this.options.createManagement,
				createWorkbench: this.options.createWorkbench,
				onError: this.options.onError,
				authentication: ownedAuthentication,
				socket,
			})
			const pending = this.pendingMessages
			this.pendingMessages = []
			this.pendingMessageBytes = 0
			for (const message of pending) socket.receive(message)
		} catch {
			authentication?.release()
			socket.close(1011, 'Runtime session initialization failed')
		}
	}

	receive(message: unknown): void {
		const socket = this.socket
		if (!socket) return
		if (this.server) {
			socket.receive(message)
			return
		}
		if (typeof message !== 'string') {
			socket.receive(message)
			return
		}
		const messageBytes = new TextEncoder().encode(message).byteLength
		if (
			this.pendingMessages.length >= MAX_INITIALIZATION_MESSAGES ||
			this.pendingMessageBytes + messageBytes > MAX_INITIALIZATION_BYTES
		) {
			socket.close(1009, 'Runtime session initialization queue exceeded')
			this.controller.abort(new Error('Runtime session initialization queue exceeded'))
			return
		}
		this.pendingMessages.push(message)
		this.pendingMessageBytes += messageBytes
	}

	transportClosed(code?: number, reason?: string): void {
		this.controller.abort(new Error('Runtime session transport closed'))
		this.socket?.closed(code ?? 1000, reason ?? '')
		this.server?.[Symbol.dispose]()
		this.server = undefined
		this.pendingMessages = []
		this.pendingMessageBytes = 0
	}
}

export function matchesRuntimeSessionUpgrade(request: Request): boolean {
	if (request.method.toUpperCase() !== 'GET') return false
	const url = new URL(request.url)
	return (
		url.pathname === RUNTIME_SESSION_PATH &&
		url.search === '' &&
		(request.headers.get('upgrade') ?? '').toLowerCase() === 'websocket' &&
		(request.headers.get('connection') ?? '')
			.toLowerCase()
			.split(',')
			.some((token) => token.trim() === 'upgrade')
	)
}

export function validateRuntimeSessionOrigin(request: Request, secure: boolean): boolean {
	if ((request.headers.get('sec-fetch-site') ?? '').toLowerCase() === 'cross-site') return false
	if (request.headers.has('sec-websocket-protocol')) return false
	const rawOrigin = request.headers.get('origin')
	if (!rawOrigin) return false
	try {
		const origin = new URL(rawOrigin)
		if (
			(origin.protocol !== 'http:' && origin.protocol !== 'https:') ||
			origin.username ||
			origin.password ||
			origin.pathname !== '/' ||
			origin.search ||
			origin.hash
		) {
			return false
		}
		if (secure && origin.protocol !== 'https:') return false
		const host = request.headers.get('host') ?? new URL(request.url).host
		return origin.host.toLowerCase() === host.trim().toLowerCase()
	} catch {
		return false
	}
}

function requestWithSignal(request: Request, signal: AbortSignal): Request {
	return new Request(request.url, {
		method: request.method,
		headers: request.headers,
		signal,
	})
}
