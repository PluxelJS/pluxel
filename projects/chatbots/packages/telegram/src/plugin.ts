import type { VaultServiceConfig as _VaultServiceConfig } from '@pluxel/runtime/services/vault'
import { BasePlugin, Plugin } from '@pluxel/runtime'
import type { TelegramUpdate } from '@gramio/types'
import { managementBinding, type MountedManagementResources } from '@pluxel/runtime/management'
import {
	BotAccountStore,
	type BotAccountConfig,
	type BotAccountInput,
} from '@repo/chatbots-adapter-kit/account-store'
import { KeyedSerialExecutor } from '@repo/chatbots-adapter-kit/keyed-serial'
import {
	AcknowledgedProjectionRegistry,
	type AcknowledgedProjection,
} from '@repo/chatbots-adapter-kit/projection'
import {
	createBotRegistry,
	normalizeBotId,
	type BotRegistry,
	type BotRegistryController,
} from '@repo/chatbots-adapter-kit/registry'
import { TelegramBot } from './bot.ts'
import { createTelegramPluginEvents } from './events.factory.ts'
import {
	TelegramManagementRpc,
	type TelegramSettingsDoc,
	type TelegramStatusDoc,
} from './management.ts'
import type { TelegramBotStatus } from './status.ts'
import { TelegramManagementModule } from './management-module.ts'

export type TelegramBotConfigInput = BotAccountInput
export type TelegramUpdateProjection = AcknowledgedProjection<TelegramBot, TelegramUpdate>

const VAULT_NAMESPACE = 'TelegramPlugin'
const DEFAULT_API_BASE = 'https://api.telegram.org'

@Plugin({ name: 'TelegramPlugin' })
export class TelegramPlugin extends BasePlugin {
	private settings?: MountedManagementResources<typeof TelegramManagementModule>['settings']
	private status?: MountedManagementResources<typeof TelegramManagementModule>['status']
	private accounts?: BotAccountStore
	private readonly registryState = createBotRegistry<TelegramBot>({
		onObserverError: (error) =>
			this.ctx.logger.warn('Telegram Bot registry observer failed', { error }),
	})
	private readonly registryController: BotRegistryController<TelegramBot> =
		this.registryState.controller
	private readonly botDisposers = new Map<string, () => void>()
	private readonly accountMutations = new KeyedSerialExecutor<string>()
	private readonly updateProjections = new AcknowledgedProjectionRegistry<
		TelegramBot,
		TelegramUpdate
	>('Telegram update projection')

	/** Live read-only platform capability registry. */
	readonly bots: BotRegistry<TelegramBot> = this.registryState.registry
	readonly events = createTelegramPluginEvents(this.ctx)

	override async init(): Promise<void> {
		const mounted = this.ctx.management.mount(TelegramManagementModule, {
			api: managementBinding.api(() => new TelegramManagementRpc(this)),
			settings: managementBinding.collection(),
			status: managementBinding.collection(),
		})
		if (mounted) {
			this.settings = mounted.resources.settings
			this.status = mounted.resources.status
			await Promise.all([this.settings.ready(), this.status.ready()])
		}
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

	/** Registers an acknowledged native-update projection. Failure keeps the polling offset unchanged. */
	registerUpdateProjection(id: string, project: TelegramUpdateProjection): () => void {
		return this.updateProjections.register(id, project)
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
			pluginEvents: this.events,
			projectUpdate: (source, update, signal) => this.projectUpdate(source, update, signal),
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

	private async projectUpdate(
		bot: TelegramBot,
		update: TelegramUpdate,
		signal: AbortSignal,
	): Promise<void> {
		await this.updateProjections.dispatch(bot, update, signal)
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
