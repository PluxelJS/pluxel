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
import { KookBot } from './bot.ts'
import type { KookEvent, KookPluginEvents } from './events.types.ts'
import type { KookBotStatus } from './status.ts'

export type KookBotConfigInput = BotAccountInput
export type KookEventConsumer = InboundConsumer<KookBot, KookEvent>

export type KookManagedAccount = Readonly<{
	config: BotAccountConfig
	bot: KookBot
}>

type KookBotManagerOptions = {
	ctx: Context
	http: Wretch
	events: KookPluginEvents
	dispatchCommand?: (bot: KookBot, event: KookEvent, signal: AbortSignal) => Promise<boolean>
}

const DEFAULT_API_BASE = 'https://www.kookapp.cn'
const VAULT_NAMESPACE = 'KookPlugin'

/** Owns KOOK account persistence, replacement ordering, registry and Bot lifetimes. */
export class KookBotManager {
	private readonly accounts: BotAccountStore
	private readonly registryState = createBotRegistry<KookBot>({
		onObserverError: (error) =>
			this.options.ctx.logger.warn('KOOK Bot registry observer failed', { error }),
	})
	private readonly registryController: BotRegistryController<KookBot> =
		this.registryState.controller
	private readonly disposers = new Map<string, () => void>()
	private readonly configs = new Map<string, BotAccountConfig>()
	private readonly mutations = new KeyedSerialExecutor<string>()
	private readonly consumers = new InboundConsumerRegistry<KookBot, KookEvent>(
		'KOOK event consumer',
	)
	private readonly listeners = new Set<() => void>()
	private disposed = false

	readonly bots: BotRegistry<KookBot> = this.registryState.registry

	constructor(private readonly options: KookBotManagerOptions) {
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

	registerEventConsumer(id: string, consumer: KookEventConsumer): () => void {
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

	listAccounts(): KookManagedAccount[] {
		return [...this.configs.values()]
			.map((config) => ({ config: { ...config }, bot: this.bots.require(config.id) }))
			.sort((a, b) => a.config.id.localeCompare(b.config.id))
	}

	async upsert(input: KookBotConfigInput): Promise<KookBot> {
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

	reconnect(idInput: string): Promise<KookBotStatus> {
		const id = normalizeBotId(idInput)
		return this.mutations.run(id, () => {
			this.assertActive()
			return this.bots.require(id).$.start()
		})
	}

	disconnect(idInput: string): Promise<KookBotStatus> {
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

	private install(config: BotAccountConfig): KookBot {
		this.uninstall(config.id)
		const bot = new KookBot({
			id: config.id,
			ctx: this.options.ctx,
			http: this.options.http,
			token: config.token,
			baseUrl: config.apiBase,
			pluginEvents: this.options.events,
			consumeEvent: (source, event, signal) => this.dispatchEvent(source, event, signal),
			onStatus: () => this.publish(),
		})
		this.configs.set(config.id, { ...config })
		this.disposers.set(config.id, this.registryController.register(config.id, bot))
		this.publish()
		return bot
	}

	private async dispatchEvent(bot: KookBot, event: KookEvent, signal: AbortSignal): Promise<void> {
		if (await this.options.dispatchCommand?.(bot, event, signal)) return
		await this.consumers.dispatch(bot, event, signal)
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
				this.options.ctx.logger.warn('KOOK Bot manager listener failed', { error })
			}
		}
	}

	private assertActive(): void {
		if (this.disposed) throw new Error('KOOK Bot manager is stopped')
	}
}
