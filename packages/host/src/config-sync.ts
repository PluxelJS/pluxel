import type { RootContext } from '@pluxel/core'
import { SuperJSON } from 'superjson'
import type { PluginCatalogSnapshot } from './catalog'
import { acceptReplicatedConfig } from './config'
import type { HostConfigStore } from './config-store'
import {
	CONFIG_SYNC_MAX_BYTES,
	configVersion,
	decodeConfigSyncSnapshot,
	type HostConfigSync,
	type HostConfigSyncOptions,
	type HostConfigSyncSnapshot,
	type HostConfigSyncStatus,
} from './config-sync-protocol'

const WATCH_MS = 20_000
const READ_MS = 30_000
const RECONNECT_MS = 1000

/** One deployment connection. Each replica reads/adopts one full snapshot at a time. */
export class HostConfigSyncConnection implements HostConfigSync {
	private readonly abort = new AbortController()
	private connection: HostConfigSyncStatus['connection'] = 'idle'
	private error: string | null = null
	private observed: HostConfigSyncSnapshot | null = null
	private refused: HostConfigSyncSnapshot | null = null
	private unavailable: HostConfigSyncStatus['unavailable'] = []
	private task: Promise<void> | undefined
	private closing: Promise<void> | undefined
	private readonly requests = new Map<string, AbortController>()

	constructor(
		private readonly ctx: RootContext,
		private readonly store: HostConfigStore,
		private readonly options: HostConfigSyncOptions,
		private readonly catalog: () => PluginCatalogSnapshot,
	) {
		ctx.effects.defer(() => this.close(), { tag: 'HostConfigSync', phase: 'shutdown' })
	}

	async prepare(): Promise<void> {
		if (this.options.role === 'writer') return
		if (this.store.snapshot) {
			const { snapshot, records } = decodeConfigSyncSnapshot(this.store.snapshot, this.options)
			this.unavailable = await acceptReplicatedConfig(this.ctx, snapshot, records, {
				catalog: this.catalog,
				restored: true,
				initial: true,
				signal: this.abort.signal,
			})
		} else {
			// No cache is allowed to create an authoritative empty document or start Plugins first.
			const snapshot = await this.read(false)
			await this.accept(snapshot, true)
		}
		this.task = this.follow()
	}

	status(): HostConfigSyncStatus {
		return Object.freeze({
			role: this.options.role,
			scope: this.options.scope,
			writer: this.options.role === 'writer' ? this.options.identity : this.options.writer,
			artifact: this.options.artifact,
			sourceVersion: configVersion(
				this.options.role === 'writer' ? this.store.snapshot : this.observed,
			),
			savedVersion: this.store.version,
			connection: this.connection,
			error: this.error,
			unavailable: this.unavailable,
		})
	}

	async fetch(request: Request): Promise<Response> {
		if (this.options.role !== 'writer')
			return new Response('Config replica is not a writer', { status: 403 })
		if (this.abort.signal.aborted) return new Response('Host is closed', { status: 503 })
		if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 })
		const identity = request.headers.get('x-pluxel-config-replica')
		const peer = this.options.replicas.find((item) => item.identity === identity)
		if (!peer || request.headers.get('authorization') !== `Bearer ${peer.token}`)
			return new Response('Unauthorized config connection', { status: 401 })
		if (this.requests.has(peer.identity))
			return new Response('Replica already has a pending read', { status: 409 })
		const url = new URL(request.url)
		const history = url.searchParams.get('history')
		const seq = url.searchParams.get('seq')
		if (
			(history === null) !== (seq === null) ||
			(seq !== null && !/^(0|[1-9][0-9]{0,15})$/.test(seq))
		)
			return new Response('Invalid config version', { status: 400 })
		const abort = new AbortController()
		this.requests.set(peer.identity, abort)
		const signal = AbortSignal.any([request.signal, this.abort.signal, abort.signal])
		try {
			await this.waitForChange(history, seq, signal)
			signal.throwIfAborted()
			return new Response(SuperJSON.stringify(this.store.snapshot), {
				headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
			})
		} finally {
			this.requests.delete(peer.identity)
		}
	}

	private waitForChange(
		history: string | null,
		seq: string | null,
		signal: AbortSignal,
	): Promise<void> {
		return new Promise((resolve, reject) => {
			let done = false
			let unsubscribe = (): void => undefined
			let timer: ReturnType<typeof setTimeout> | undefined
			const settle = (error?: unknown): void => {
				if (done) return
				done = true
				unsubscribe()
				if (timer) clearTimeout(timer)
				signal.removeEventListener('abort', aborted)
				if (error) reject(error)
				else resolve()
			}
			const aborted = (): void => settle(signal.reason)
			// Subscribe before inspecting the current version: a concurrent commit cannot be missed.
			unsubscribe = this.store.subscribeSaved(() => settle())
			signal.addEventListener('abort', aborted, { once: true })
			const version = this.store.version
			if (signal.aborted) aborted()
			else if (version?.history !== history || String(version.seq) !== seq) settle()
			else timer = setTimeout(() => settle(), WATCH_MS)
		})
	}

	private async read(watch: boolean): Promise<HostConfigSyncSnapshot> {
		if (this.options.role !== 'replica') throw new Error('[host:config-sync] Not a replica')
		const url = new URL(this.options.url)
		const version = configVersion(this.observed) ?? this.store.version
		if (watch && version) {
			url.searchParams.set('history', version.history)
			url.searchParams.set('seq', String(version.seq))
		}
		this.connection = 'connecting'
		const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(READ_MS)])
		const response = await fetch(url, {
			signal,
			redirect: 'error',
			headers: {
				authorization: `Bearer ${this.options.token}`,
				'x-pluxel-config-replica': this.options.identity,
			},
		})
		if (!response.ok) {
			await response.body?.cancel()
			throw new Error(`[host:config-sync] Writer request failed with HTTP ${response.status}`)
		}
		const reader = response.body?.getReader()
		if (!reader) throw new Error('[host:config-sync] Writer returned no document')
		const chunks: Uint8Array[] = []
		let bytes = 0
		try {
			for (;;) {
				const item = await reader.read()
				if (item.done) break
				bytes += item.value.byteLength
				// SuperJSON quoting and metadata can expand the bounded saved body.
				if (bytes > CONFIG_SYNC_MAX_BYTES * 2)
					throw new Error('[host:config-sync] Response budget exceeded')
				chunks.push(item.value)
			}
		} finally {
			await reader.cancel()
			reader.releaseLock()
		}
		const buffer = new Uint8Array(bytes)
		let offset = 0
		for (const chunk of chunks) {
			buffer.set(chunk, offset)
			offset += chunk.byteLength
		}
		const decoded = decodeConfigSyncSnapshot(
			SuperJSON.parse(new TextDecoder().decode(buffer)),
			this.options,
		)
		this.observed = decoded.snapshot
		this.connection = 'connected'
		return decoded.snapshot
	}

	private async accept(snapshot: HostConfigSyncSnapshot, initial = false): Promise<void> {
		if (
			this.refused?.history === snapshot.history &&
			this.refused.seq === snapshot.seq &&
			this.refused.body === snapshot.body
		)
			return
		const saved = this.store.snapshot
		if (!initial && saved?.history === snapshot.history && snapshot.seq < saved.seq) return
		if (
			!initial &&
			saved?.history === snapshot.history &&
			saved.seq === snapshot.seq &&
			saved.body === snapshot.body
		) {
			this.error = null
			return
		}
		const { records } = decodeConfigSyncSnapshot(snapshot, this.options)
		try {
			this.unavailable = await acceptReplicatedConfig(this.ctx, snapshot, records, {
				catalog: this.catalog,
				initial,
				signal: this.abort.signal,
			})
			this.refused = null
			this.error = null
		} catch (error) {
			this.refused = snapshot
			throw error
		}
	}

	private async follow(): Promise<void> {
		let watch = false
		while (!this.abort.signal.aborted) {
			try {
				const snapshot = await this.read(watch)
				await this.accept(snapshot)
				watch = true
			} catch (error) {
				if (this.abort.signal.aborted) break
				this.error = (error instanceof Error ? error.message : String(error)).slice(0, 4096)
				if (this.store.hasPersistenceFault) {
					this.connection = 'failed'
					return
				}
				this.connection = 'disconnected'
				watch = false
				await new Promise<void>((resolve) => {
					const finish = (): void => {
						clearTimeout(timer)
						this.abort.signal.removeEventListener('abort', finish)
						resolve()
					}
					const timer = setTimeout(finish, RECONNECT_MS)
					this.abort.signal.addEventListener('abort', finish, { once: true })
					if (this.abort.signal.aborted) finish()
				})
			}
		}
	}

	close(): Promise<void> {
		return (this.closing ??= (async () => {
			this.abort.abort(new Error('[host:config-sync] Host is closing'))
			for (const request of this.requests.values()) request.abort(this.abort.signal.reason)
			await this.task
			this.connection = 'closed'
		})())
	}
}
