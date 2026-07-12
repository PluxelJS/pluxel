import {
	SupersedingAbortScope,
	type CapabilityRef,
	type ChatHubPlugin,
	type ChatSendRequest,
} from '@repo/chatbots-hub'
import { createKookClient, type KookClientOptions } from './api/client.ts'
import { KOOK_ENDPOINTS } from './api/endpoints.ts'
import type { KookApi, KookApiTools, KookAutoApi, Result } from './api/types.ts'
import {
	encodeKookBlock,
	KOOK_TRANSPORT_CAPABILITIES,
	normalizeKookEvent,
	parseKookConversationId,
} from './codec.ts'
import { KookEventObservers } from './events.ts'
import { KookGateway } from './gateway.ts'
import type { KookEvent } from './protocol.ts'

export type KookBotPhase = 'offline' | 'connecting' | 'online' | 'error' | 'destroyed'

export type KookBotStatus = {
	phase: KookBotPhase
	botId: string | null
	username: string | null
	lastError: string | null
	updatedAt: number
}

export type KookBotLogger = {
	info(message: string, data?: Record<string, unknown>): void
	warn(message: string, data?: Record<string, unknown>): void
}

export type KookBotOptions = Omit<KookClientOptions, 'signal'> & {
	id: string
	hub?: CapabilityRef<Pick<ChatHubPlugin, 'registerTransport' | 'receive'>>
	logger: KookBotLogger
	onStatus?: (status: KookBotStatus) => void
	onEvent?: (bot: KookBot, event: KookEvent, signal: AbortSignal) => void | Promise<void>
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
	readonly raw: KookBotRawApi
	readonly status: Readonly<KookBotStatus>
	channel: KookApiTools['createConversation']
	direct: KookApiTools['createDirectConversation']
	createAsset: KookApiTools['createAsset']
	start(): Promise<KookBotStatus>
	stop(): KookBotStatus
	destroy(): void
}

const invokeKookEndpoint = Symbol('invokeKookEndpoint')

/** One configured KOOK account. Native KOOK API methods are inherited directly. */
// oxlint-disable-next-line typescript/no-unsafe-declaration-merging -- macro inventory installs every merged method on the shared prototype below.
export class KookBot {
	readonly id: string
	readonly events = new KookEventObservers()
	readonly $: KookBotExtensions
	readonly #owner = new AbortController()
	readonly #api: KookApi
	readonly #options: KookBotOptions
	private readonly connection = new SupersedingAbortScope()
	private gateway?: KookGateway
	private disposeTransport?: () => void
	private readonly disposeHubObserver?: () => void
	private connectionActive = false
	private statusValue: KookBotStatus = {
		phase: 'offline',
		botId: null,
		username: null,
		lastError: null,
		updatedAt: Date.now(),
	}

	constructor(botOptions: KookBotOptions) {
		this.#options = botOptions
		this.id = botOptions.id
		this.#api = createKookClient({ ...botOptions, signal: this.#owner.signal })
		this.disposeHubObserver = botOptions.hub?.observe(() => this.refreshTransport())
		const extensions: KookBotExtensions = {
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
			const botId = identity.id
			const username = identity.username ?? identity.nickname ?? ''
			this.connectionActive = true
			this.refreshTransport()
			this.gateway = new KookGateway(
				{
					getUrl: async (signal) =>
						unwrap(await this.#api.$raw.call('getGateway', { compress: 0 }, signal)).url,
					onEvent: async (event, signal) => {
						await this.events.dispatch(event, signal, (handler, error) =>
							this.#options.logger.warn('KOOK event handler failed', { handler, error }),
						)
						await this.#options.onEvent?.(this, event, signal)
						const message = normalizeKookEvent(event, botId, this.id)
						if (message) await this.#options.hub?.current?.receive(message, signal)
					},
					onOnline: (sessionId) => {
						this.setStatus('online', { botId, username })
						this.#options.logger.info('KOOK gateway online', {
							accountId: this.id,
							sessionId,
						})
					},
					onOffline: () => this.setStatus('offline', { botId, username }),
					onError: (error) => this.setError(error),
				},
				this.#options.logger,
			)
			this.gateway.start(lease.signal)
			return this.setStatus('connecting', { botId, username })
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
		this.connectionActive = false
		this.gateway?.stop()
		this.gateway = undefined
		this.disposeTransport?.()
		this.disposeTransport = undefined
		return updateStatus && this.statusValue.phase !== 'destroyed'
			? this.setStatus('offline')
			: this.statusValue
	}

	private destroy(): void {
		if (this.statusValue.phase === 'destroyed') return
		this.stopConnection(false)
		this.disposeHubObserver?.()
		this.#owner.abort(new Error(`KOOK bot destroyed: ${this.id}`))
		this.setStatus('destroyed')
	}

	private async sendToPlatform(request: ChatSendRequest, signal?: AbortSignal) {
		const target = parseKookConversationId(request.conversationId)
		const content = Array.isArray(request.content) ? request.content : []
		let lastMessageId = ''
		for (const block of content) {
			if (signal?.aborted) throw signal.reason
			const payload = {
				target_id: target.targetId,
				...encodeKookBlock(block),
				...(request.replyToId ? { quote: request.replyToId } : {}),
			}
			const sent = target.direct
				? unwrap(await this.#api.$raw.call('createDirectMessage', payload, signal))
				: unwrap(await this.#api.$raw.call('sendMessage', payload, signal))
			lastMessageId = sent.msg_id
		}
		if (!lastMessageId) throw new Error('KOOK send requires non-empty content')
		return { messageId: lastMessageId }
	}

	private refreshTransport(): void {
		this.disposeTransport?.()
		this.disposeTransport = undefined
		const hub = this.#options.hub?.current
		if (!hub || !this.connectionActive) return
		this.disposeTransport = hub.registerTransport({
			platform: 'kook',
			accountId: this.id,
			capabilities: KOOK_TRANSPORT_CAPABILITIES,
			send: (request, signal) => this.sendToPlatform(request, signal),
		})
	}

	private setStatus(
		phase: KookBotPhase,
		identity: { botId?: string; username?: string } = {},
	): KookBotStatus {
		this.statusValue = Object.freeze({
			phase,
			botId: identity.botId ?? this.statusValue.botId,
			username: identity.username ?? this.statusValue.username,
			lastError: null,
			updatedAt: Date.now(),
		})
		this.#options.onStatus?.(this.statusValue)
		return this.statusValue
	}

	private setError(error: unknown): KookBotStatus {
		this.statusValue = Object.freeze({
			...this.statusValue,
			phase: 'error',
			lastError: error instanceof Error ? error.message : String(error),
			updatedAt: Date.now(),
		})
		this.#options.onStatus?.(this.statusValue)
		return this.statusValue
	}

	private assertAlive(): void {
		if (this.statusValue.phase === 'destroyed') throw new Error(`KOOK bot is destroyed: ${this.id}`)
	}

	[invokeKookEndpoint](endpoint: keyof KookAutoApi, payload?: unknown) {
		return this.#api.$raw.call(endpoint, payload as never)
	}
}

export interface KookBot extends KookAutoApi {}

// Bot instances contain no endpoint closures; native methods live once on this prototype.
for (const [endpoint] of KOOK_ENDPOINTS) {
	if (Object.hasOwn(KookBot.prototype, endpoint)) continue
	Object.defineProperty(KookBot.prototype, endpoint, {
		configurable: false,
		enumerable: false,
		value(this: KookBot, payload?: unknown) {
			return this[invokeKookEndpoint](endpoint, payload)
		},
	})
}

function unwrap<Value>(result: Result<Value>): Value {
	if (result.ok === true) return result.data
	const failure = result as Extract<Result<Value>, { ok: false }>
	throw new Error(`KOOK API error ${failure.code}: ${failure.message}`)
}
