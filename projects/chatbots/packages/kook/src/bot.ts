import { SupersedingAbortScope } from '@repo/chatbots-adapter-kit/scope'
import type { Context } from '@pluxel/runtime'
import { createKookClient, type KookClientOptions } from './api/client.ts'
import { invokeKookNative, KookNativeApi } from './api/native.ts'
import type { KookApi, KookApiTools, KookAutoApi, Result } from './api/types.ts'
import { dispatchKookEvent } from './events.dispatch.ts'
import { createKookBotEvents } from './events.factory.ts'
import type { KookBotEvents, KookPluginEvents } from './events.types.ts'
import { createKookGatewaySnapshot, KookGateway, type KookGatewaySnapshot } from './gateway.ts'
import type { KookEvent } from './protocol.ts'
import {
	createKookBotStatus,
	updateKookBotStatus,
	type KookBotPhase,
	type KookBotStatus,
} from './status.ts'
import type { User } from './types/base.ts'

export type KookBotOptions = Omit<KookClientOptions, 'signal'> & {
	id: string
	ctx: Context
	pluginEvents?: KookPluginEvents
	projectEvent?: (bot: KookBot, event: KookEvent, signal: AbortSignal) => void | Promise<void>
	onStatus?: (status: KookBotStatus) => void
}

export type KookBotCallOptions = { signal?: AbortSignal }
export type KookBotRawCallArgs<Endpoint extends keyof KookAutoApi> = undefined extends Parameters<
	KookAutoApi[Endpoint]
>[0]
	? [payload?: Parameters<KookAutoApi[Endpoint]>[0], options?: KookBotCallOptions]
	: [payload: Parameters<KookAutoApi[Endpoint]>[0], options?: KookBotCallOptions]
export type KookBotRawApi = {
	request<Value = unknown>(
		method: import('./api/types.ts').HttpMethod,
		path: string,
		payload?: import('./api/types.ts').RequestPayload,
		options?: KookBotCallOptions,
	): Promise<Result<Value>>
	call<Endpoint extends keyof KookAutoApi>(
		endpoint: Endpoint,
		...args: KookBotRawCallArgs<Endpoint>
	): ReturnType<KookAutoApi[Endpoint]>
}

export type KookBotExtensions = {
	readonly info: Readonly<{ id: string; baseUrl: string; apiPrefix: string }>
	readonly raw: KookBotRawApi
	readonly status: Readonly<KookBotStatus>
	channel: KookApiTools['createConversation']
	direct: KookApiTools['createDirectConversation']
	createAsset: KookApiTools['createAsset']
	start(): Promise<KookBotStatus>
	stop(): KookBotStatus
	destroy(): void
}

/** One configured KOOK account. Native KOOK API methods are inherited directly. */
export class KookBot extends KookNativeApi {
	readonly id: string
	selfInfo?: User
	readonly events: KookBotEvents
	readonly $: KookBotExtensions
	readonly #owner = new AbortController()
	readonly #api: KookApi
	readonly #options: KookBotOptions
	readonly #logger: ReturnType<Context['logger']['with']>
	private readonly connection = new SupersedingAbortScope()
	private gateway?: KookGateway
	private statusValue = createKookBotStatus(createKookGatewaySnapshot())

	constructor(botOptions: KookBotOptions) {
		super()
		this.#options = botOptions
		this.id = botOptions.id
		this.#logger = botOptions.ctx.logger.with({ platform: 'kook', accountId: this.id })
		this.events = createKookBotEvents(botOptions.ctx)
		const baseUrl = (botOptions.baseUrl?.trim() || 'https://www.kookapp.cn').replace(/\/+$/, '')
		const apiPrefix = normalizeApiPrefix(botOptions.apiPrefix ?? '/api/v3')
		this.#api = createKookClient({
			token: botOptions.token,
			baseUrl,
			apiPrefix,
			fetch: botOptions.fetch,
			signal: this.#owner.signal,
		})
		const extensions: KookBotExtensions = {
			info: Object.freeze({ id: this.id, baseUrl, apiPrefix }),
			raw: {
				request: (method, path, payload, options) =>
					this.#api.$raw.request(method, path, payload, options?.signal),
				call: (endpoint, ...args) => {
					const [payload, options] = args
					return this.#api.$raw.call(endpoint, payload as never, options?.signal)
				},
			} as KookBotRawApi,
			status: this.statusValue,
			channel: (id, defaults) => this.#api.$tool.createConversation(id, defaults),
			direct: (target, defaults) => this.#api.$tool.createDirectConversation(target, defaults),
			createAsset: (file, name) => this.#api.$tool.createAsset(file, name),
			start: () => this.connect(),
			stop: () => this.stopConnection(),
			destroy: () => this.destroy(),
		}
		Object.defineProperty(extensions, 'status', {
			enumerable: true,
			get: () => this.statusValue,
		})
		this.$ = Object.freeze(extensions)
	}

	private async connect(): Promise<KookBotStatus> {
		this.assertAlive()
		this.stopConnection(false)
		const lease = this.connection.renew()
		this.setStatus('connecting')
		try {
			const identity = unwrap(await this.#api.$raw.call('getUserMe', undefined, lease.signal))
			lease.throwIfStale()
			this.selfInfo = identity
			const botId = identity.id
			const username = identity.username ?? identity.nickname ?? ''
			this.setStatus('connecting', { botId, username })
			this.gateway = new KookGateway(
				{
					getUrl: async (request, signal) => {
						const value = unwrap(await this.#api.$raw.call('getGateway', { compress: 0 }, signal))
						const url = new URL(value.url)
						if (request.resume && request.sessionId) {
							url.searchParams.set('resume', '1')
							url.searchParams.set('sn', String(request.lastSequence))
							url.searchParams.set('session_id', request.sessionId)
						}
						return url.toString()
					},
					onEvent: async (event, signal) => {
						await dispatchKookEvent(this, this.events, this.#options.pluginEvents, event, signal)
						await this.#options.projectEvent?.(this, event, signal)
					},
					onOnline: (sessionId) => {
						this.#logger.info('KOOK gateway online', {
							accountId: this.id,
							sessionId,
						})
					},
					onOffline: () => undefined,
					onError: (error) => this.setError(error),
					onSnapshot: (snapshot) => this.applyGatewaySnapshot(snapshot),
				},
				this.#logger,
			)
			this.gateway.start(lease.signal)
			return this.statusValue
		} catch (error) {
			if (lease.current()) {
				this.stopConnection(false)
				this.setError(error)
			}
			throw error
		}
	}

	private stopConnection(updateStatus = true): KookBotStatus {
		this.connection.abort()
		this.gateway?.stop()
		this.gateway = undefined
		return updateStatus && this.statusValue.phase !== 'destroyed'
			? this.setStatus('offline')
			: this.statusValue
	}

	private destroy(): void {
		if (this.statusValue.phase === 'destroyed') return
		this.stopConnection(false)
		this.#owner.abort(new Error(`KOOK bot destroyed: ${this.id}`))
		this.setStatus('destroyed')
	}

	private setStatus(
		phase: KookBotPhase,
		identity: { botId?: string; username?: string } = {},
	): KookBotStatus {
		this.statusValue = updateKookBotStatus(this.statusValue, {
			phase,
			botId: identity.botId ?? this.statusValue.botId,
			username: identity.username ?? this.statusValue.username,
			lastError: null,
			connectedAt:
				phase === 'online'
					? (this.statusValue.connectedAt ?? Date.now())
					: phase === 'error'
						? this.statusValue.connectedAt
						: null,
		})
		this.#options.onStatus?.(this.statusValue)
		return this.statusValue
	}

	private setError(error: unknown): KookBotStatus {
		this.statusValue = updateKookBotStatus(this.statusValue, {
			phase: 'error',
			lastError: error instanceof Error ? error.message : String(error),
		})
		this.#options.onStatus?.(this.statusValue)
		return this.statusValue
	}

	private applyGatewaySnapshot(snapshot: KookGatewaySnapshot): void {
		const previous = this.statusValue
		const phase: KookBotPhase =
			previous.phase === 'destroyed'
				? 'destroyed'
				: snapshot.phase === 'online'
					? 'online'
					: snapshot.phase === 'backoff' && snapshot.lastError
						? 'error'
						: snapshot.phase === 'connecting' || snapshot.phase === 'resuming'
							? 'connecting'
							: 'offline'
		this.statusValue = updateKookBotStatus(previous, {
			phase,
			gateway: snapshot,
			lastError: snapshot.lastError,
			connectedAt:
				phase === 'online'
					? previous.phase === 'online'
						? previous.connectedAt
						: Date.now()
					: phase === 'error'
						? previous.connectedAt
						: null,
		})
		const meaningful =
			phase !== previous.phase ||
			snapshot.sessionId !== previous.gateway.sessionId ||
			snapshot.lastSequence !== previous.gateway.lastSequence ||
			snapshot.bufferedEvents !== previous.gateway.bufferedEvents ||
			snapshot.counters.reconnectAttempts !== previous.gateway.counters.reconnectAttempts ||
			snapshot.counters.resumeAttempts !== previous.gateway.counters.resumeAttempts ||
			snapshot.counters.duplicateEvents !== previous.gateway.counters.duplicateEvents ||
			snapshot.counters.outOfOrderEvents !== previous.gateway.counters.outOfOrderEvents ||
			snapshot.counters.bufferOverflows !== previous.gateway.counters.bufferOverflows ||
			snapshot.currentBackoffMs !== previous.gateway.currentBackoffMs ||
			snapshot.lastError !== previous.gateway.lastError
		if (meaningful) this.#options.onStatus?.(this.statusValue)
	}

	private assertAlive(): void {
		if (this.statusValue.phase === 'destroyed') throw new Error(`KOOK bot is destroyed: ${this.id}`)
	}

	protected [invokeKookNative](endpoint: keyof KookAutoApi, payload?: unknown): unknown {
		return this.#api.$raw.call(endpoint, payload as never)
	}
}

function unwrap<Value>(result: Result<Value>): Value {
	if (result.ok === true) return result.data
	const failure = result as Extract<Result<Value>, { ok: false }>
	throw new Error(`KOOK API error ${failure.code}: ${failure.message}`)
}

function normalizeApiPrefix(value: string): string {
	const trimmed = value.trim().replace(/\/+$/, '')
	return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}
