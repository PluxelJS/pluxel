import { type BotAccountConfig, BotAccountStore } from '@repo/chatbots-platform-kit/account-store'
import { KeyedSerialExecutor } from '@repo/chatbots-platform-kit/keyed-serial'
import { maskBotSecret } from '@repo/chatbots-platform-kit/bot-admin'
import {
	createBotRegistry,
	normalizeBotId,
	type BotRegistryController,
} from '@repo/chatbots-platform-kit/registry'
import type { Context } from '@pluxel/runtime'
import type { DiscordCommandCatalogSnapshot, DiscordCommandSource } from '../commands.ts'
import type {
	DiscordButtonContext,
	DiscordBotConfigInput,
	DiscordBotDirectory,
	DiscordBotSnapshot,
} from '../protocol.ts'
import { DiscordBot } from './bot.ts'
import { DiscordManagedCommandStore } from './command-sync.ts'
import type { DiscordAdminAccount } from '../workbench/contract.ts'

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
	private commandSyncTail: Promise<void> = Promise.resolve()
	private disposed = false

	readonly bots: DiscordBotDirectory = {
		list: () => [...this.registryState.registry.values()].map((bot) => bot.snapshot()),
		get: (id) => this.registryState.registry.get(id),
		observe: (observer) => {
			this.listeners.add(observer)
			return () => this.listeners.delete(observer)
		},
	}

	constructor(private readonly options: DiscordBotManagerOptions) {
		const vault = options.ctx.vault.namespace(VAULT_NAMESPACE).kv()
		this.accounts = new BotAccountStore(vault, DEFAULT_API_BASE)
		this.managedCommands = new DiscordManagedCommandStore(vault)
	}

	adminAccounts(): DiscordAdminAccount[] {
		return [...this.configs.values()]
			.map((config) => {
				const snapshot = this.registryState.registry.require(config.id).snapshot()
				return Object.assign(
					{
						id: config.id,
						tokenPreview: maskBotSecret(config.token),
						state: snapshot.state,
						guilds: snapshot.guilds,
						epoch: snapshot.epoch,
					},
					snapshot.username ? { username: snapshot.username } : {},
					snapshot.applicationId ? { applicationId: snapshot.applicationId } : {},
					snapshot.connectedAt ? { connectedAt: snapshot.connectedAt } : {},
					snapshot.lastHealthyAt ? { lastHealthyAt: snapshot.lastHealthyAt } : {},
					snapshot.failureMessage ? { failureMessage: snapshot.failureMessage } : {},
				)
			})
			.toSorted((left, right) => left.id.localeCompare(right.id))
	}

	observe(observer: () => void): () => void {
		this.listeners.add(observer)
		return () => this.listeners.delete(observer)
	}

	async start(): Promise<void> {
		for (const id of await this.accounts.list()) {
			const config = await this.accounts.read(id)
			if (!config) continue
			const bot = this.install(config)
			void bot
				.start()
				.then(() => this.syncCommands())
				.catch((error: unknown) => this.reportError(error, id))
		}
	}

	async upsert(input: DiscordBotConfigInput): Promise<DiscordBot> {
		const id = normalizeBotId(input.id)
		return this.mutations.run(id, async () => {
			this.assertActive()
			const config = await this.accounts.upsert({ id, token: input.token })
			await this.options.ctx.vault.flush()
			const bot = this.install(config)
			await bot.start()
			await this.syncCommands()
			return bot
		})
	}

	async remove(idInput: string): Promise<void> {
		const id = normalizeBotId(idInput)
		await this.mutations.run(id, async () => {
			this.assertActive()
			await this.accounts.remove(id)
			await this.options.ctx.vault.flush()
			this.uninstall(id)
		})
	}

	reconnect(idInput: string): Promise<DiscordBotSnapshot> {
		const id = normalizeBotId(idInput)
		return this.mutations.run(id, async () => {
			this.assertActive()
			const snapshot = await this.registryState.registry.require(id).start()
			await this.syncCommands()
			return snapshot
		})
	}

	disconnect(idInput: string): Promise<DiscordBotSnapshot> {
		const id = normalizeBotId(idInput)
		return this.mutations.run(id, async () => {
			this.assertActive()
			return this.registryState.registry.require(id).stop()
		})
	}

	async dispose(): Promise<void> {
		if (this.disposed) return
		this.disposed = true
		await Promise.allSettled([...this.registryState.registry.values()].map((bot) => bot.stop()))
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
				if (bot.snapshot().state !== 'ready') return
				const previous = await this.managedCommands.read(bot.id)
				const current = await bot.refreshCommands(catalog, previous)
				await this.managedCommands.write(bot.id, current)
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
		this.configs.set(config.id, config)
		this.disposers.set(config.id, this.registryController.register(config.id, bot))
		this.publish()
		return bot
	}

	private uninstall(id: string): void {
		this.registryState.registry.get(id)?.destroy()
		this.disposers.get(id)?.()
		this.disposers.delete(id)
		this.configs.delete(id)
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

	private reportError(error: unknown, botId: string): void {
		this.options.ctx.logger.warn('Discord bot operation failed', { error, botId })
	}
}
