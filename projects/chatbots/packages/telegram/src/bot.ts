import type { APIMethodParams, APIMethodReturn } from '@gramio/types'
import type { Context } from '@pluxel/runtime'
import {
	abortableDelay,
	ChatHubPlugin,
	ExponentialBackoff,
	normalizeContent,
	SupersedingAbortScope,
	type CapabilityRef,
	type ChatMessage,
	type ChatSendRequest,
} from '@repo/chatbots-hub'
import { createTelegramClient, type TelegramClientOptions, type TelegramApi } from './api/client.ts'
import type { TelegramMethod } from './api/endpoints.ts'
import { invokeTelegramNative, TelegramNativeApi } from './api/native.ts'
import { TELEGRAM_UPDATE_KEYS } from './api/updates.ts'
import {
	normalizeTelegramUpdate,
	TELEGRAM_TRANSPORT_CAPABILITIES,
	telegramOutboundPayload,
} from './codec.ts'
import {
	createTelegramBotEvents,
	dispatchTelegramUpdate,
	type TelegramBotEvents,
	type TelegramPluginEvents,
} from './events.ts'

export type TelegramBotPhase = 'offline' | 'connecting' | 'online' | 'error' | 'destroyed'

export type TelegramBotStatus = {
	phase: TelegramBotPhase
	botId: string | null
	username: string | null
	lastError: string | null
	updatedAt: number
}

export type TelegramRawApi = {
	call<Method extends TelegramMethod>(
		endpoint: Method,
		...args: undefined extends APIMethodParams<Method>
			? [payload?: APIMethodParams<Method>, options?: { signal?: AbortSignal }]
			: [payload: APIMethodParams<Method>, options?: { signal?: AbortSignal }]
	): Promise<APIMethodReturn<Method>>
}

export type TelegramBotOptions = Omit<TelegramClientOptions, 'signal'> & {
	id: string
	ctx: Context
	hub?: CapabilityRef<Pick<ChatHubPlugin, 'registerTransport' | 'receive'>>
	pluginEvents?: TelegramPluginEvents
	pollingTimeoutSeconds?: number
	onStatus?: (status: TelegramBotStatus) => void
}

export type TelegramBotExtensions = {
	readonly info: Readonly<{ id: string; apiBase: string }>
	readonly raw: TelegramRawApi
	readonly status: Readonly<TelegramBotStatus>
	start(): Promise<TelegramBotStatus>
	stop(): TelegramBotStatus
	destroy(): void
}

/** One configured Telegram account with GramIO-native methods on the Bot itself. */
export class TelegramBot extends TelegramNativeApi {
	readonly id: string
	selfInfo?: APIMethodReturn<'getMe'>
	readonly events: TelegramBotEvents
	readonly $: TelegramBotExtensions
	readonly #owner = new AbortController()
	readonly #api: TelegramApi
	readonly #options: TelegramBotOptions
	readonly #logger: ReturnType<Context['logger']['with']>
	private readonly connection = new SupersedingAbortScope()
	private readonly pollingBackoff = new ExponentialBackoff({ initialMs: 2_000, maxMs: 30_000 })
	private disposeTransport?: () => void
	private readonly disposeHubObserver?: () => void
	private connectionActive = false
	private offset = 0
	private statusValue: TelegramBotStatus = {
		phase: 'offline',
		botId: null,
		username: null,
		lastError: null,
		updatedAt: Date.now(),
	}

	constructor(botOptions: TelegramBotOptions) {
		super()
		this.#options = botOptions
		this.id = botOptions.id
		this.#logger = botOptions.ctx.logger.with({ platform: 'telegram', accountId: this.id })
		this.events = createTelegramBotEvents(botOptions.ctx)
		const apiBase = (botOptions.apiBase?.trim() || 'https://api.telegram.org').replace(/\/+$/, '')
		this.#api = createTelegramClient({
			token: botOptions.token,
			apiBase,
			fetch: botOptions.fetch,
			signal: this.#owner.signal,
		})
		this.disposeHubObserver = botOptions.hub?.observe(() => this.refreshTransport())
		const extensions: TelegramBotExtensions = {
			info: Object.freeze({ id: this.id, apiBase }),
			raw: {
				call: (endpoint, payload, options) =>
					this.#api.call(endpoint, payload as never, options?.signal),
			} as TelegramRawApi,
			status: this.statusValue,
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

	private async connect(): Promise<TelegramBotStatus> {
		this.assertAlive()
		this.stopConnection(false)
		const lease = this.connection.renew()
		this.setStatus('connecting')
		try {
			const identity = await this.#api.call('getMe', undefined, lease.signal)
			lease.throwIfStale()
			this.selfInfo = identity
			this.connectionActive = true
			this.refreshTransport()
			const botId = String(identity.id)
			const username = identity.username ?? ''
			this.setStatus('online', { botId, username })
			void this.poll(lease.signal)
			return this.statusValue
		} catch (error) {
			if (lease.current()) {
				this.stopConnection(false)
				this.setError(error)
			}
			throw error
		}
	}

	private async poll(signal: AbortSignal): Promise<void> {
		while (!signal.aborted) {
			try {
				const updates = await this.#api.call(
					'getUpdates',
					{
						offset: this.offset,
						timeout: this.#options.pollingTimeoutSeconds ?? 25,
						allowed_updates: [...TELEGRAM_UPDATE_KEYS],
					},
					signal,
				)
				this.pollingBackoff.reset()
				this.setStatus('online')
				const messages: ChatMessage[] = []
				for (const update of updates) {
					this.offset = Math.max(this.offset, update.update_id + 1)
					await dispatchTelegramUpdate(
						this,
						this.events,
						this.#options.pluginEvents,
						update,
						signal,
					)
					const message = normalizeTelegramUpdate(update, this.id)
					if (message) messages.push(message)
				}
				const hub = this.#options.hub?.current
				if (hub) await Promise.all(messages.map((message) => hub.receive(message, signal)))
			} catch (error) {
				if (signal.aborted) return
				this.setError(error)
				this.#logger.warn('Telegram polling failed; retrying', {
					accountId: this.id,
					error,
				})
				await abortableDelay(this.pollingBackoff.next(), signal).catch((): void => undefined)
			}
		}
	}

	private async sendToPlatform(request: ChatSendRequest, signal?: AbortSignal) {
		const blocks = normalizeContent(request.content)
		if (blocks.length !== 1)
			throw new Error('Telegram transport expects one planned block per send')
		const payload = telegramOutboundPayload(blocks[0]!)
		const sent = await this.#api.call(
			payload.method,
			{
				chat_id: request.conversationId,
				...payload.body,
				...(request.replyToId
					? { reply_parameters: { message_id: Number(request.replyToId) } }
					: {}),
			} as never,
			signal,
		)
		return { messageId: String(sent.message_id) }
	}

	private stopConnection(updateStatus = true): TelegramBotStatus {
		this.connection.abort()
		this.connectionActive = false
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
		this.#owner.abort(new Error(`Telegram bot destroyed: ${this.id}`))
		this.setStatus('destroyed')
	}

	private setStatus(
		phase: TelegramBotPhase,
		identity: { botId?: string; username?: string } = {},
	): TelegramBotStatus {
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

	private refreshTransport(): void {
		this.disposeTransport?.()
		this.disposeTransport = undefined
		const hub = this.#options.hub?.current
		if (!hub || !this.connectionActive) return
		this.disposeTransport = hub.registerTransport({
			platform: 'telegram',
			accountId: this.id,
			capabilities: TELEGRAM_TRANSPORT_CAPABILITIES,
			send: (request, signal) => this.sendToPlatform(request, signal),
		})
	}

	private setError(error: unknown): TelegramBotStatus {
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
		if (this.statusValue.phase === 'destroyed')
			throw new Error(`Telegram bot is destroyed: ${this.id}`)
	}

	protected [invokeTelegramNative](endpoint: TelegramMethod, payload?: unknown): unknown {
		return this.#api.call(endpoint, payload as never)
	}
}
