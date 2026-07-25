import type { APIMethodReturn, TelegramUpdate } from '@gramio/types'
import type { Context } from '@pluxel/runtime'
import { abortableDelay, ExponentialBackoff } from '@repo/chatbots-platform-kit/backoff'
import { SupersedingAbortScope } from '@repo/chatbots-platform-kit/scope'
import {
	createTelegramClient,
	type TelegramApi,
	type TelegramClientOptions,
	type TelegramRawApi,
} from '../api/client.ts'
import type { TelegramMethod } from '../api/endpoints.ts'
import { invokeTelegramNative, TelegramNativeApi } from '../api/native.ts'
import { TELEGRAM_UPDATE_KEYS } from '../api/updates.ts'
import { dispatchTelegramUpdate } from './events.dispatch.ts'
import { createTelegramBotEvents } from './events.factory.ts'
import type { TelegramBotEvents, TelegramPluginEvents } from './events.types.ts'
import {
	createTelegramBotStatus,
	updateTelegramBotStatus,
	type TelegramBotPhase,
	type TelegramBotStatus,
} from './status.ts'

export type TelegramBotOptions = Omit<TelegramClientOptions, 'signal'> & {
	id: string
	ctx: Context
	pluginEvents?: TelegramPluginEvents
	consumeUpdate?: (
		bot: TelegramBot,
		update: TelegramUpdate,
		signal: AbortSignal,
	) => void | Promise<void>
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
	private offset = 0
	private statusValue = createTelegramBotStatus()

	constructor(botOptions: TelegramBotOptions) {
		super()
		this.#options = botOptions
		this.id = botOptions.id
		this.#logger = botOptions.ctx.logger.with({ platform: 'telegram', accountId: this.id })
		this.events = createTelegramBotEvents(botOptions.ctx)
		const apiBase = (botOptions.apiBase?.trim() || 'https://api.telegram.org').replace(/\/+$/, '')
		this.#api = createTelegramClient({
			http: botOptions.http,
			token: botOptions.token,
			apiBase,
			signal: this.#owner.signal,
		})
		const extensions: TelegramBotExtensions = {
			info: Object.freeze({ id: this.id, apiBase }),
			raw: this.#api.$.raw,
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
		this.setStatus('connecting', {}, { polling: { currentBackoffMs: 0 } })
		try {
			const identity = await this.#api.$.raw.call('getMe', undefined, { signal: lease.signal })
			lease.throwIfStale()
			this.selfInfo = identity
			const botId = String(identity.id)
			const username = identity.username ?? ''
			this.setStatus('online', { botId, username }, { connectedAt: Date.now() })
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
				this.patchStatus({ polling: { lastPollAt: Date.now() } }, false)
				const updates = await this.#api.$.raw.call(
					'getUpdates',
					{
						offset: this.offset,
						timeout: this.#options.pollingTimeoutSeconds ?? 25,
						allowed_updates: [...TELEGRAM_UPDATE_KEYS],
					},
					{ signal },
				)
				this.pollingBackoff.reset()
				let lastUpdateId: number | null = null
				for (const update of updates) {
					await dispatchTelegramUpdate(
						this,
						this.events,
						this.#options.pluginEvents,
						update,
						signal,
					)
					await this.#options.consumeUpdate?.(this, update, signal)
					this.offset = Math.max(this.offset, update.update_id + 1)
					lastUpdateId = update.update_id
				}
				const recovered = this.statusValue.phase !== 'online' || this.statusValue.lastError !== null
				this.patchStatus(
					{
						phase: 'online',
						lastError: null,
						polling: {
							offset: this.offset,
							consecutiveFailures: 0,
							currentBackoffMs: 0,
							...(lastUpdateId === null ? {} : { lastUpdateId, lastUpdateAt: Date.now() }),
						},
					},
					recovered || lastUpdateId !== null,
				)
			} catch (error) {
				if (signal.aborted) return
				const delay = this.pollingBackoff.next()
				this.setError(error, delay)
				this.#logger.warn('Telegram polling failed; retrying', {
					accountId: this.id,
					delay,
					error,
				})
				await abortableDelay(delay, signal).catch((): void => undefined)
			}
		}
	}

	private stopConnection(updateStatus = true): TelegramBotStatus {
		this.connection.abort()
		return updateStatus && this.statusValue.phase !== 'destroyed'
			? this.setStatus('offline', {}, { polling: { currentBackoffMs: 0 } })
			: this.statusValue
	}

	private destroy(): void {
		if (this.statusValue.phase === 'destroyed') return
		this.stopConnection(false)
		this.#owner.abort(new Error(`Telegram bot destroyed: ${this.id}`))
		this.setStatus('destroyed')
	}

	private setStatus(
		phase: TelegramBotPhase,
		identity: { botId?: string; username?: string } = {},
		patch: Parameters<typeof updateTelegramBotStatus>[1] = {},
	): TelegramBotStatus {
		this.statusValue = updateTelegramBotStatus(this.statusValue, {
			...patch,
			phase,
			botId: identity.botId ?? this.statusValue.botId,
			username: identity.username ?? this.statusValue.username,
			lastError: patch.lastError ?? null,
			connectedAt:
				phase === 'online'
					? (patch.connectedAt ?? this.statusValue.connectedAt)
					: phase === 'error'
						? this.statusValue.connectedAt
						: null,
		})
		this.#options.onStatus?.(this.statusValue)
		return this.statusValue
	}

	private setError(error: unknown, delay = 0): TelegramBotStatus {
		this.statusValue = updateTelegramBotStatus(this.statusValue, {
			phase: 'error',
			lastError: error instanceof Error ? error.message : String(error),
			polling: {
				consecutiveFailures:
					delay > 0
						? this.statusValue.polling.consecutiveFailures + 1
						: this.statusValue.polling.consecutiveFailures,
				currentBackoffMs: delay,
			},
		})
		this.#options.onStatus?.(this.statusValue)
		return this.statusValue
	}

	private patchStatus(
		patch: Parameters<typeof updateTelegramBotStatus>[1],
		publish = true,
	): TelegramBotStatus {
		this.statusValue = updateTelegramBotStatus(this.statusValue, patch)
		if (publish) this.#options.onStatus?.(this.statusValue)
		return this.statusValue
	}

	private assertAlive(): void {
		if (this.statusValue.phase === 'destroyed')
			throw new Error(`Telegram bot is destroyed: ${this.id}`)
	}

	protected [invokeTelegramNative](endpoint: TelegramMethod, payload?: unknown): unknown {
		return this.#api.$.raw.call(endpoint, payload as never)
	}
}
