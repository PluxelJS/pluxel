import { type BotAccountConfig, BotAccountStore } from '@repo/chatbots-platform-kit/account-store'
import { KeyedSerialExecutor } from '@repo/chatbots-platform-kit/keyed-serial'
import {
	createBotRegistry,
	normalizeBotId,
	type BotRegistry,
	type BotRegistryController,
} from '@repo/chatbots-platform-kit/registry'
import type { Context } from '@pluxel/runtime'
import type { DiscordCommandCatalogSnapshot, DiscordCommandSource } from '../commands.ts'
import type {
	DiscordButtonContext,
	DiscordBotConfigInput,
} from '../protocol.ts'
import { DiscordBot } from './bot.ts'
import type { DiscordBotStatus } from './status.ts'
import { DiscordManagedCommandStore } from './command-sync.ts'

export type DiscordBotManagerOptions = Readonly<{
	ctx: Context
	commandGuildIds: readonly string[]
	readyTimeoutMs: number
	commandCatalog(): DiscordCommandCatalogSnapshot
	dispatchCommand(context: DiscordCommandSource): Promise<boolean>
	matchesInteraction(customId: string): boolean
	dispatchInteraction(context: DiscordButtonContext): Promise<boolean>
}>

const VAULT_NAMESPACE = 'DiscordPlugin'
const DEFAULT_API_BASE = 'https://discord.com/api/v10'

export type DiscordManagedAccount = Readonly<{
	config: BotAccountConfig
	bot: DiscordBot
}>

export class DiscordBotManager {
	private readonly accounts: BotAccountStore
	private readonly managedCommands: DiscordManagedCommandStore
	private readonly registryState = createBotRegistry<DiscordBot>({
		onObserverError: (error) =>
			this.options.ctx.logger.warn('Discord Bot registry observer failed', { error }),
	})
	private readonly registryController: BotRegistryController<DiscordBot> =
		this.registryState.controller
	private readonly disposers = new Map<string, () => void>()
	private readonly configs = new Map<string, BotAccountConfig>()
	private readonly mutations = new KeyedSerialExecutor<string>()
	private readonly listeners = new Set<() => void>()
	private readonly syncedCatalogs = new Map<string, Readonly<{ epoch: number; revision: number }>>()
	private commandSyncTail: Promise<void> = Promise.resolve()
	private disposed = false

	readonly bots: BotRegistry<DiscordBot> = this.registryState.registry

	constructor(private readonly options: DiscordBotManagerOptions) {
		const vault = options.ctx.vault.namespace(VAULT_NAMESPACE).kv()
		this.accounts = new BotAccountStore(vault, DEFAULT_API_BASE)
		this.managedCommands = new DiscordManagedCommandStore(vault)
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

	listAccounts(): DiscordManagedAccount[] {
		return [...this.configs.values()]
			.map((config) => ({ config: { ...config }, bot: this.bots.require(config.id) }))
			.sort((a, b) => a.config.id.localeCompare(b.config.id))
	}

	async start(): Promise<void> {
		this.assertActive()
		for (const id of await this.accounts.list()) {
			const config = await this.accounts.read(id)
			if (!config) continue
			const bot = this.install(config)
			void bot
				.$.start()
				.then(() => this.syncCommands())
				.catch((error: unknown) => this.reportError(error, id))
		}
	}

	async upsert(input: DiscordBotConfigInput): Promise<DiscordBot> {
		const id = normalizeBotId(input.id)
		return this.mutations.run(id, async () => {
			this.assertActive()
			const config = await this.accounts.upsert({ ...input, id })
			await this.options.ctx.vault.flush()
			const bot = this.install(config)
			await bot.$.start()
			await this.syncCommands()
			return bot
		})
	}

	async remove(idInput: string): Promise<void> {
		const id = normalizeBotId(idInput)
		await this.mutations.run(id, async () => {
			this.assertActive()
			const bot = this.registryState.registry.get(id)
			if (bot?.$.status.phase === 'online') await this.withdrawCommands(bot)
			await this.accounts.remove(id)
			await this.managedCommands.delete(id)
			await this.options.ctx.vault.flush()
			this.uninstall(id)
		})
	}

	reconnect(idInput: string): Promise<DiscordBotStatus> {
		const id = normalizeBotId(idInput)
		return this.mutations.run(id, async () => {
			this.assertActive()
			const status = await this.registryState.registry.require(id).$.start()
			await this.syncCommands()
			return status
		})
	}

	disconnect(idInput: string): Promise<DiscordBotStatus> {
		const id = normalizeBotId(idInput)
		return this.mutations.run(id, async () => {
			this.assertActive()
			return this.registryState.registry.require(id).$.stop()
		})
	}

	async dispose(): Promise<void> {
		if (this.disposed) return
		this.disposed = true
		await Promise.allSettled([...this.registryState.registry.values()].map((bot) => bot.$.stop()))
		for (const id of this.registryState.registry.keys()) this.uninstall(id)
		this.configs.clear()
		this.listeners.clear()
	}

	async syncCommands(): Promise<void> {
		const operation = this.commandSyncTail.then(() => this.syncCommandsNow())
		this.commandSyncTail = operation.catch((): void => undefined)
		await operation
	}

	private async syncCommandsNow(): Promise<void> {
		const catalog = this.options.commandCatalog()
		await Promise.all(
			[...this.registryState.registry.values()].map(async (bot) => {
				const status = bot.$.status
				if (status.phase !== 'online') return
				const synced = this.syncedCatalogs.get(bot.id)
				if (synced?.epoch === status.gateway.epoch && synced.revision === catalog.revision)
					return
				const previous = await this.managedCommands.read(bot.id)
				const current = await bot.refreshCommands(catalog, previous)
				await this.managedCommands.write(bot.id, current)
				this.syncedCatalogs.set(bot.id, {
					epoch: status.gateway.epoch,
					revision: catalog.revision,
				})
			}),
		)
		await this.options.ctx.vault.flush()
	}

	private install(config: BotAccountConfig): DiscordBot {
		this.uninstall(config.id)
		const bot = new DiscordBot(config, {
			commandGuildIds: this.options.commandGuildIds,
			readyTimeoutMs: this.options.readyTimeoutMs,
			commandCatalog: this.options.commandCatalog,
			dispatchCommand: this.options.dispatchCommand,
			matchesInteraction: this.options.matchesInteraction,
			dispatchInteraction: this.options.dispatchInteraction,
			onChanged: () => this.publish(),
			onError: (error) => this.reportError(error, config.id),
		})
		this.configs.set(config.id, { ...config })
		this.disposers.set(config.id, this.registryController.register(config.id, bot))
		this.publish()
		return bot
	}

	private uninstall(id: string): void {
		this.registryState.registry.get(id)?.$.destroy()
		this.disposers.get(id)?.()
		this.disposers.delete(id)
		this.configs.delete(id)
		this.syncedCatalogs.delete(id)
		this.publish()
	}

	private publish(): void {
		for (const listener of this.listeners) {
			try {
				listener()
			} catch (error) {
				this.reportError(error, 'observer')
			}
		}
	}

	private assertActive(): void {
		if (this.disposed) throw new Error('Discord bot manager is stopped')
	}

	private async withdrawCommands(bot: DiscordBot): Promise<void> {
		const previous = await this.managedCommands.read(bot.id)
		await bot.refreshCommands(
			{ revision: this.options.commandCatalog().revision, definitions: [] },
			previous,
		)
	}

	private reportError(error: unknown, botId: string): void {
		this.options.ctx.logger.warn('Discord bot operation failed', { error, botId })
	}
}
