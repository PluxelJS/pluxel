import type { VaultServiceConfig as _VaultServiceConfig } from '@pluxel/runtime/services/vault'
import { BasePlugin, Plugin } from '@pluxel/runtime'
import type { ExtensionUiRpcMap as _ExtensionUiRpcMap } from '@pluxel/runtime/web'
import { ui, type ManagementStateCollection } from '@pluxel/runtime/web-management'
import {
	BotAccountStore,
	type BotAccountConfig,
	type BotAccountInput,
} from '@repo/chatbots-adapter-kit/account-store'
import { createCapabilityRef } from '@repo/chatbots-adapter-kit/capability-ref'
import { KeyedSerialExecutor } from '@repo/chatbots-adapter-kit/keyed-serial'
import {
	createBotRegistry,
	normalizeBotId,
	type BotRegistry,
	type BotRegistryController,
} from '@repo/chatbots-adapter-kit/registry'
import { ChatHubPlugin } from '@repo/chatbots-hub'
import { TelegramBot } from './bot.ts'
import { createTelegramPluginEvents } from './events.factory.ts'
import {
	TelegramManagementRpc,
	type TelegramSettingsDoc,
	type TelegramStatusDoc,
} from './management.ts'
import type { TelegramBotStatus } from './status.ts'

export type TelegramBotConfigInput = BotAccountInput

const pluginUi = ui(import.meta.url, './ui/index.tsx')
const VAULT_NAMESPACE = 'TelegramPlugin'
const DEFAULT_API_BASE = 'https://api.telegram.org'

@Plugin({ name: 'TelegramPlugin' })
export class TelegramPlugin extends BasePlugin {
	private settings?: ManagementStateCollection<TelegramSettingsDoc>
	private status?: ManagementStateCollection<TelegramStatusDoc>
	private accounts?: BotAccountStore
	private readonly hubBinding = createCapabilityRef<
		Pick<ChatHubPlugin, 'registerTransport' | 'receive'>
	>({
		onObserverError: (error) =>
			this.ctx.logger.warn('Telegram ChatHub binding observer failed', { error }),
	})
	private readonly registryState = createBotRegistry<TelegramBot>({
		onObserverError: (error) =>
			this.ctx.logger.warn('Telegram Bot registry observer failed', { error }),
	})
	private readonly registryController: BotRegistryController<TelegramBot> =
		this.registryState.controller
	private readonly botDisposers = new Map<string, () => void>()
	private readonly accountMutations = new KeyedSerialExecutor<string>()

	/** Live read-only platform capability registry. */
	readonly bots: BotRegistry<TelegramBot> = this.registryState.registry
	readonly events = createTelegramPluginEvents(this.ctx)

	override async init(): Promise<void> {
		this.ctx.effects.defer(
			this.plugins.use(ChatHubPlugin, (hub) => {
				this.hubBinding.controller.set(hub)
				return () => this.hubBinding.controller.set(undefined)
			}),
		)
		await this.ctx.webManagement.use(async (web) => {
			this.settings = web.state.collection<TelegramSettingsDoc>({ name: 'settings' })
			this.status = web.state.collection<TelegramStatusDoc>({ name: 'status' })
			await Promise.all([this.settings.ready(), this.status.ready()])
			web.ui.register(pluginUi)
			web.rpc.expose(() => new TelegramManagementRpc(this))
		})
		this.settings?.removeMany({})
		this.status?.removeMany({})
		this.accounts = new BotAccountStore(this.kv(), DEFAULT_API_BASE)
		this.ctx.effects.defer(() => this.destroyAllBots())
		for (const id of await this.accounts.list()) {
			const stored = await this.accounts.read(id)
			if (!stored) continue
			const bot = this.installBot(id, stored.token, stored.apiBase)
			this.projectSettings(id, stored)
			void bot.$.start().catch((): void => undefined)
		}
	}

	bot(id: string): TelegramBot {
		return this.bots.require(id)
	}

	async upsertBot(input: TelegramBotConfigInput): Promise<TelegramBot> {
		const id = normalizeBotId(input.id)
		return this.accountMutations.run(id, async () => {
			const stored = await this.accountStore().upsert({ ...input, id })
			await this.ctx.vault.flush()
			const bot = this.installBot(stored.id, stored.token, stored.apiBase)
			this.projectSettings(stored.id, stored)
			await bot.$.start()
			return bot
		})
	}

	async removeBot(idInput: string): Promise<void> {
		const id = normalizeBotId(idInput)
		return this.accountMutations.run(id, async () => {
			await this.accountStore().remove(id)
			await this.ctx.vault.flush()
			this.removeRuntimeBot(id)
			this.settings?.removeOne({ id })
			this.status?.removeOne({ id })
		})
	}

	async reconnectBot(id: string): Promise<TelegramBotStatus> {
		const normalized = normalizeBotId(id)
		return this.accountMutations.run(normalized, async () => {
			return this.bot(normalized).$.start()
		})
	}

	disconnectBot(id: string): Promise<TelegramBotStatus> {
		const normalized = normalizeBotId(id)
		return this.accountMutations.run(normalized, async () => {
			return this.bot(normalized).$.stop()
		})
	}

	private installBot(id: string, token: string, apiBase: string): TelegramBot {
		this.removeRuntimeBot(id)
		const bot = new TelegramBot({
			id,
			ctx: this.ctx,
			token,
			apiBase,
			hub: this.hubBinding.ref,
			pluginEvents: this.events,
			onStatus: (next) => this.projectStatus(id, next),
		})
		this.botDisposers.set(id, this.registryController.register(id, bot))
		this.projectStatus(id, bot.$.status)
		return bot
	}

	private removeRuntimeBot(id: string): void {
		this.bots.get(id)?.$.destroy()
		this.botDisposers.get(id)?.()
		this.botDisposers.delete(id)
	}

	private destroyAllBots(): void {
		for (const id of this.bots.keys()) this.removeRuntimeBot(id)
	}

	private projectSettings(id: string, stored: BotAccountConfig): void {
		const doc: TelegramSettingsDoc = {
			id,
			tokenPreview: maskSecret(stored.token),
			apiBase: stored.apiBase,
			updatedAt: Date.now(),
		}
		this.settings?.replaceOne({ id }, doc, { upsert: true })
	}

	private projectStatus(id: string, status: TelegramBotStatus): void {
		const doc: TelegramStatusDoc = {
			id,
			phase: status.phase === 'destroyed' ? 'offline' : status.phase,
			botId: status.botId,
			username: status.username,
			lastError: status.lastError,
			startedAt: status.startedAt,
			connectedAt: status.connectedAt,
			lastUpdateId: status.polling.lastUpdateId,
			lastUpdateAt: status.polling.lastUpdateAt,
			consecutiveFailures: status.polling.consecutiveFailures,
			currentBackoffMs: status.polling.currentBackoffMs,
			updatedAt: status.updatedAt,
		}
		this.status?.replaceOne({ id }, doc, { upsert: true })
	}

	private kv() {
		return this.ctx.vault.namespace(VAULT_NAMESPACE).kv()
	}

	private accountStore(): BotAccountStore {
		if (!this.accounts) throw new Error('TelegramPlugin is not initialized')
		return this.accounts
	}
}

function maskSecret(value: string): string {
	return value.length <= 8 ? '••••••••' : `${value.slice(0, 4)}••••${value.slice(-4)}`
}

declare module '@pluxel/runtime/web' {
	interface ExtensionUiRpcMap {
		TelegramPlugin: TelegramManagementRpc
	}

	interface ExtensionUiSignalDbMap {
		TelegramPlugin: {
			settings: TelegramSettingsDoc
			status: TelegramStatusDoc
		}
	}
}
