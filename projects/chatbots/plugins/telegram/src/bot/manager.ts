import type { TelegramUpdate } from '@gramio/types'
import type { Context } from '@pluxel/runtime'
import type { Wretch } from '@pluxel/wretch'
import {
	BotAccountStore,
	type BotAccountConfig,
	type BotAccountInput,
} from '@repo/chatbots-platform-kit/account-store'
import {
	InboundConsumerRegistry,
	type InboundConsumer,
} from '@repo/chatbots-platform-kit/inbound-consumers'
import { KeyedSerialExecutor } from '@repo/chatbots-platform-kit/keyed-serial'
import {
	createBotRegistry,
	normalizeBotId,
	type BotRegistry,
	type BotRegistryController,
} from '@repo/chatbots-platform-kit/registry'
import { TelegramBot } from './bot.ts'
import type { TelegramPluginEvents } from './events.types.ts'
import type { TelegramBotStatus } from './status.ts'

export type TelegramBotConfigInput = BotAccountInput
export type TelegramUpdateConsumer = InboundConsumer<TelegramBot, TelegramUpdate>

export type TelegramManagedAccount = Readonly<{
	config: BotAccountConfig
	bot: TelegramBot
}>

type TelegramBotManagerOptions = {
	ctx: Context
	http: Wretch
	events: TelegramPluginEvents
}

const DEFAULT_API_BASE = 'https://api.telegram.org'
const VAULT_NAMESPACE = 'TelegramPlugin'

/** Owns Telegram account persistence, replacement ordering, registry and Bot lifetimes. */
export class TelegramBotManager {
	private readonly accounts: BotAccountStore
	private readonly registryState = createBotRegistry<TelegramBot>({
		onObserverError: (error) =>
			this.options.ctx.logger.warn('Telegram Bot registry observer failed', { error }),
	})
	private readonly registryController: BotRegistryController<TelegramBot> =
		this.registryState.controller
	private readonly disposers = new Map<string, () => void>()
	private readonly configs = new Map<string, BotAccountConfig>()
	private readonly mutations = new KeyedSerialExecutor<string>()
	private readonly consumers = new InboundConsumerRegistry<TelegramBot, TelegramUpdate>(
		'Telegram update consumer',
	)
	private readonly listeners = new Set<() => void>()
	private disposed = false

	readonly bots: BotRegistry<TelegramBot> = this.registryState.registry

	constructor(private readonly options: TelegramBotManagerOptions) {
		this.accounts = new BotAccountStore(
			options.ctx.vault.namespace(VAULT_NAMESPACE).kv(),
			DEFAULT_API_BASE,
		)
	}

	async start(): Promise<void> {
		this.assertActive()
		for (const id of await this.accounts.list()) {
			const config = await this.accounts.read(id)
			if (!config) continue
			const bot = this.install(config)
			void bot.$.start().catch((): void => undefined)
		}
	}

	registerUpdateConsumer(id: string, consumer: TelegramUpdateConsumer): () => void {
		this.assertActive()
		return this.consumers.register(id, consumer)
	}

	subscribe(listener: () => void): () => void {
		this.assertActive()
		this.listeners.add(listener)
		let active = true
		return () => {
			if (!active) return
			active = false
			this.listeners.delete(listener)
		}
	}

	listAccounts(): TelegramManagedAccount[] {
		return [...this.configs.values()]
			.map((config) => ({ config: { ...config }, bot: this.bots.require(config.id) }))
			.sort((a, b) => a.config.id.localeCompare(b.config.id))
	}

	async upsert(input: TelegramBotConfigInput): Promise<TelegramBot> {
		const id = normalizeBotId(input.id)
		return this.mutations.run(id, async () => {
			this.assertActive()
			const config = await this.accounts.upsert({ ...input, id })
			await this.options.ctx.vault.flush()
			const bot = this.install(config)
			await bot.$.start()
			return bot
		})
	}

	async remove(idInput: string): Promise<void> {
		const id = normalizeBotId(idInput)
		return this.mutations.run(id, async () => {
			this.assertActive()
			await this.accounts.remove(id)
			await this.options.ctx.vault.flush()
			this.uninstall(id)
			this.configs.delete(id)
			this.publish()
		})
	}

	reconnect(idInput: string): Promise<TelegramBotStatus> {
		const id = normalizeBotId(idInput)
		return this.mutations.run(id, () => {
			this.assertActive()
			return this.bots.require(id).$.start()
		})
	}

	disconnect(idInput: string): Promise<TelegramBotStatus> {
		const id = normalizeBotId(idInput)
		return this.mutations.run(id, async () => {
			this.assertActive()
			return this.bots.require(id).$.stop()
		})
	}

	dispose(): void {
		if (this.disposed) return
		this.disposed = true
		this.consumers.clear()
		for (const id of this.bots.keys()) this.uninstall(id)
		this.configs.clear()
		this.listeners.clear()
	}

	private install(config: BotAccountConfig): TelegramBot {
		this.uninstall(config.id)
		const bot = new TelegramBot({
			id: config.id,
			ctx: this.options.ctx,
			http: this.options.http,
			token: config.token,
			apiBase: config.apiBase,
			pluginEvents: this.options.events,
			consumeUpdate: (source, update, signal) => this.consumers.dispatch(source, update, signal),
			onStatus: () => this.publish(),
		})
		this.configs.set(config.id, { ...config })
		this.disposers.set(config.id, this.registryController.register(config.id, bot))
		this.publish()
		return bot
	}

	private uninstall(id: string): void {
		this.bots.get(id)?.$.destroy()
		this.disposers.get(id)?.()
		this.disposers.delete(id)
	}

	private publish(): void {
		for (const listener of this.listeners) {
			try {
				listener()
			} catch (error) {
				this.options.ctx.logger.warn('Telegram Bot manager listener failed', { error })
			}
		}
	}

	private assertActive(): void {
		if (this.disposed) throw new Error('Telegram Bot manager is stopped')
	}
}
