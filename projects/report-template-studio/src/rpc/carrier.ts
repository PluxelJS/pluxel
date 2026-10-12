import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { chmod, mkdtemp, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { join } from 'node:path'
import { RpcSession, RpcTarget } from 'capnweb'
import type { DesktopApi } from '../shared/contracts.js'
import {
	checkPrivateDirectory,
	descriptorFile,
	publicInstance,
	studioDiscoveryDirectory,
	studioUserKey,
	STUDIO_PROTOCOL_VERSION,
	type StudioDescriptor,
} from '../client/protocol.js'
import { acquireStudioRoot } from './root-lock.js'
import {
	ApiGeneration,
	DesktopRpcTarget,
	NativeDesktopRpcTarget,
	StudioRpcTarget,
	type NativeDesktopApi,
} from './targets.js'
import { StudioSocketTransport } from './socket.js'
import { StudioMessagePortTransport, type StudioMessagePort } from './message-port.js'
import { rpcError, RPC_SESSION_OPTIONS } from './errors.js'

class AuthenticationTarget extends RpcTarget {
	#descriptor: StudioDescriptor
	#generation: () => ApiGeneration | undefined
	#authenticated: () => void
	constructor(
		descriptor: StudioDescriptor,
		generation: () => ApiGeneration | undefined,
		authenticated: () => void,
	) {
		super()
		this.#descriptor = descriptor
		this.#generation = generation
		this.#authenticated = authenticated
	}
	async authenticate(input: { instanceId: string; token: string; protocolVersion: number }) {
		if (
			!input ||
			input.instanceId !== this.#descriptor.instanceId ||
			input.protocolVersion !== STUDIO_PROTOCOL_VERSION ||
			typeof input.token !== 'string' ||
			!/^[0-9a-f]{64}$/.test(input.token) ||
			!timingSafeEqual(Buffer.from(input.token, 'hex'), Buffer.from(this.#descriptor.token, 'hex'))
		)
			throw rpcError('UNAUTHORIZED', 'Studio authentication failed')
		const generation = this.#generation()
		if (!generation)
			throw rpcError('BACKEND_UNAVAILABLE', 'Studio backend is updating or unavailable')
		this.#authenticated()
		const { discoveryDirectory: _, ...identity } = publicInstance(this.#descriptor, '')
		return { identity, api: new StudioRpcTarget(generation) }
	}
}

/** A host owns this carrier; connections never own the Plugin or its document sessions. */
export class StudioRpcCarrier {
	readonly root: string
	readonly instanceId: string
	#ownership: Awaited<ReturnType<typeof acquireStudioRoot>>
	#directory: string
	#descriptor: StudioDescriptor
	#server: Server
	#socketDirectory?: string
	#published = false
	#api?: NativeDesktopApi
	#generation?: ApiGeneration
	#retired = new Set<ApiGeneration>()
	#connections = new Set<(reason: Error) => void>()
	#closing?: Promise<void>
	#closed = false

	private constructor(input: {
		ownership: Awaited<ReturnType<typeof acquireStudioRoot>>
		directory: string
		descriptor: StudioDescriptor
		server: Server
		socketDirectory?: string
	}) {
		this.#ownership = input.ownership
		this.root = input.ownership.root
		this.instanceId = input.ownership.instanceId
		this.#directory = input.directory
		this.#descriptor = input.descriptor
		this.#server = input.server
		this.#socketDirectory = input.socketDirectory
	}

	static async create(config: {
		root: string
		discoveryDirectory?: string
	}): Promise<StudioRpcCarrier> {
		const ownership = await acquireStudioRoot(config.root)
		let socketDirectory: string | undefined
		let server: Server | undefined
		try {
			const directory = await checkPrivateDirectory(
				studioDiscoveryDirectory(config.discoveryDirectory),
				true,
			)
			if (process.platform !== 'win32') {
				// macOS's per-user TMPDIR and container profile paths can exceed AF_UNIX's
				// address limit. The socket uses a short, owned directory independently of discovery.
				socketDirectory = await mkdtemp(`/tmp/rts-${studioUserKey().slice(0, 8)}-`)
				await chmod(socketDirectory, 0o700)
			}
			const descriptor: StudioDescriptor = {
				instanceId: ownership.instanceId,
				root: ownership.root,
				pid: process.pid,
				platform: process.platform,
				protocolVersion: STUDIO_PROTOCOL_VERSION,
				token: randomBytes(32).toString('hex'),
				address:
					process.platform === 'win32'
						? `\\\\.\\pipe\\pluxel-report-template-studio-${studioUserKey()}-${ownership.instanceId}`
						: join(socketDirectory!, 'rpc.sock'),
			}
			server = createServer()
			const carrier = new StudioRpcCarrier({
				ownership,
				directory,
				descriptor,
				server,
				socketDirectory,
			})
			server.on('connection', (socket) => {
				if (carrier.#closed || carrier.#connections.size >= 64) {
					socket.destroy()
					return
				}
				const transport = new StudioSocketTransport(socket)
				const close = (reason: Error) => transport.abort(reason)
				carrier.#connections.add(close)
				const timer = setTimeout(
					() => close(rpcError('UNAUTHORIZED', 'Studio authentication deadline expired')),
					5000,
				)
				timer.unref()
				socket.once('close', () => {
					clearTimeout(timer)
					carrier.#connections.delete(close)
				})
				const session = new RpcSession(
					transport,
					new AuthenticationTarget(
						descriptor,
						() => carrier.#generation,
						() => clearTimeout(timer),
					),
					RPC_SESSION_OPTIONS,
				)
				session.getRemoteMain().onRpcBroken(() => {
					clearTimeout(timer)
					carrier.#connections.delete(close)
				})
			})
			await new Promise<void>((resolve, reject) => {
				server!.once('error', reject)
				server!.listen({ path: descriptor.address }, () => {
					server!.off('error', reject)
					resolve()
				})
			})
			// Later listener failures revoke capabilities instead of becoming unhandled events.
			server.on('error', (cause) =>
				carrier.withdraw(rpcError('BACKEND_UNAVAILABLE', 'Studio IPC listener failed', cause)),
			)
			if (process.platform !== 'win32') await chmod(descriptor.address, 0o600)
			return carrier
		} catch (error) {
			if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()))
			if (socketDirectory) await rm(socketDirectory, { recursive: true, force: true })
			await ownership.release()
			throw error
		}
	}

	get api(): DesktopApi {
		if (!this.#generation || this.#closed)
			throw rpcError('BACKEND_UNAVAILABLE', 'Studio backend is unavailable')
		return new DesktopRpcTarget(this.#generation)
	}

	/** Called with the currently running Plugin after every accepted Host generation. */
	setApi(api: NativeDesktopApi | undefined, resolve?: () => NativeDesktopApi | undefined): void {
		if (this.#closed || this.#api === api) return
		this.withdraw(
			rpcError('BACKEND_UNAVAILABLE', 'Studio backend generation was replaced; reconnect'),
		)
		this.#api = api
		if (api) this.#generation = new ApiGeneration(api, resolve)
	}

	withdraw(
		reason = rpcError('BACKEND_UNAVAILABLE', 'Studio backend generation was withdrawn'),
	): void {
		if (this.#generation) {
			const generation = this.#generation
			generation.withdraw()
			this.#retired.add(generation)
			void generation.drain().finally(() => this.#retired.delete(generation))
		}
		this.#generation = undefined
		this.#api = undefined
		for (const close of this.#connections) close(reason)
		this.#connections.clear()
	}

	async publish(): Promise<void> {
		if (this.#published) return
		if (!this.#generation || this.#closed)
			throw rpcError('BACKEND_UNAVAILABLE', 'Studio backend did not become ready')
		const temporary = join(this.#directory, `${this.instanceId}.${randomUUID()}.tmp`)
		try {
			await writeFile(temporary, JSON.stringify(this.#descriptor), { flag: 'wx', mode: 0o600 })
			await rename(temporary, descriptorFile(this.#directory, this.instanceId))
			this.#published = true
		} finally {
			await unlink(temporary).catch(() => {})
		}
	}

	connectDesktopPort(port: StudioMessagePort, options: { native?: boolean } = {}): () => void {
		if (!this.#generation || this.#closed) {
			port.close()
			throw rpcError('BACKEND_UNAVAILABLE', 'Studio backend is unavailable')
		}
		if (this.#connections.size >= 64) {
			port.close()
			throw rpcError('BUSY', 'Studio connection capacity is full')
		}
		const transport = new StudioMessagePortTransport(port)
		const close = (reason: Error) => {
			this.#connections.delete(close)
			transport.shutdown(reason)
		}
		this.#connections.add(close)
		const target = options.native
			? new NativeDesktopRpcTarget(this.#generation)
			: new DesktopRpcTarget(this.#generation)
		const session = new RpcSession(transport, target, RPC_SESSION_OPTIONS)
		const remote = session.getRemoteMain()
		remote.onRpcBroken(() => this.#connections.delete(close))
		return () => close(rpcError('CLOSED', 'Studio desktop port disconnected'))
	}

	close(closeHost: () => Promise<void> = async () => {}): Promise<void> {
		return (this.#closing ??= (async () => {
			this.#closed = true
			const listenerClosed = this.#server.listening
				? new Promise<void>((resolve, reject) =>
						this.#server.close((error) => (error ? reject(error) : resolve())),
					)
				: Promise.resolve()
			this.withdraw(rpcError('CLOSED', 'Studio host is closing'))
			const errors: unknown[] = []
			for (const task of [
				() => listenerClosed,
				() => Promise.all([...this.#retired].map((generation) => generation.drain())),
				closeHost,
				async () => {
					if (this.#published) await unlink(descriptorFile(this.#directory, this.instanceId))
				},
				async () => {
					if (this.#socketDirectory)
						await rm(this.#socketDirectory, { recursive: true, force: true })
				},
				() => this.#ownership.release(),
			]) {
				try {
					await task()
				} catch (error) {
					errors.push(error)
				}
			}
			if (errors.length > 0)
				throw new AggregateError(errors, 'Studio host cleanup failed', { cause: errors[0] })
		})())
	}
}
