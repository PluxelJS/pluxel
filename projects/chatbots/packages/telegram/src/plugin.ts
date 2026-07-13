import type { VaultServiceConfig as _VaultServiceConfig } from '@pluxel/runtime/services/vault'
import { BasePlugin, Plugin } from '@pluxel/runtime'
import type { ExtensionUiRpcMap as _ExtensionUiRpcMap } from '@pluxel/runtime/web'
import { ui, type ManagementStateCollection } from '@pluxel/runtime/web-management'
import { createCapabilityRef } from '@repo/chatbots-adapter-kit/capability-ref'
import { TokenBotConfigStore, type TokenBotConfigInput } from '@repo/chatbots-adapter-kit/config'
import {
	createBotRegistry,
	type BotRegistry,
	type BotRegistryController,
} from '@repo/chatbots-adapter-kit/registry'
import { ChatHubPlugin } from '@repo/chatbots-hub'
import { TelegramBot } from './bot.ts'
import { createTelegramPluginEvents } from './events.ts'
import type { TelegramSettingsDoc, TelegramStatusDoc } from './protocol.ts'
import { TelegramAdapterRpc } from './rpc.ts'
import type { TelegramBotStatus } from './status.ts'

export type TelegramBotConfigInput = TokenBotConfigInput

const pluginUi = ui(import.meta.url, './ui/index.tsx')
const VAULT_NAMESPACE = 'TelegramAdapterPlugin'
const DEFAULT_API_BASE = 'https://api.telegram.org'

@Plugin({ name: 'TelegramPlugin' })
export class TelegramPlugin extends BasePlugin {
	private settings?: ManagementStateCollection<TelegramSettingsDoc>
	private status?: ManagementStateCollection<TelegramStatusDoc>
	private config?: TokenBotConfigStore
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
			web.rpc.expose(() => new TelegramAdapterRpc(this))
		})
		this.settings?.removeMany({})
		this.status?.removeMany({})
		this.config = new TokenBotConfigStore(this.kv(), { defaultApiBase: DEFAULT_API_BASE })
		for (const id of await this.config.list()) {
			const stored = await this.config.read(id)
			if (!stored) continue
			const bot = this.installBot(id, stored.token, stored.apiBase)
			this.projectSettings(id, stored)
			void bot.$.start().catch((): void => undefined)
		}
		this.ctx.effects.defer(() => this.destroyAllBots())
	}

	bot(id: string): TelegramBot {
		return this.bots.require(id)
	}

	async upsertBot(input: TelegramBotConfigInput): Promise<TelegramSettingsDoc> {
		const stored = await this.configStore().upsert(input)
		await this.ctx.vault.flush()
		const bot = this.installBot(stored.id, stored.token, stored.apiBase)
		await bot.$.start()
		return this.projectSettings(stored.id, stored)
	}

	async removeBot(idInput: string): Promise<{ ok: true }> {
		const id = await this.configStore().remove(idInput)
		this.removeRuntimeBot(id)
		await this.ctx.vault.flush()
		this.settings?.removeOne({ id })
		this.status?.removeOne({ id })
		return { ok: true }
	}

	async testBot(id: string): Promise<{ ok: boolean; message: string }> {
		try {
			const identity = await this.bot(id).getMe()
			return { ok: true, message: `Telegram Bot @${identity.username ?? identity.id} 鉴权成功。` }
		} catch (error) {
			return { ok: false, message: errorMessage(error) }
		}
	}

	async reconnectBot(id: string): Promise<TelegramStatusDoc> {
		await this.bot(id).$.start()
		return this.currentStatus(id)
	}

	disconnectBot(id: string): TelegramStatusDoc {
		this.bot(id).$.stop()
		return this.currentStatus(id)
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

	private projectSettings(
		id: string,
		stored: { token?: string; apiBase: string },
	): TelegramSettingsDoc {
		const doc: TelegramSettingsDoc = {
			id,
			accountId: id,
			hasToken: Boolean(stored.token),
			tokenPreview: maskSecret(stored.token),
			apiBase: stored.apiBase,
			updatedAt: Date.now(),
		}
		this.settings?.replaceOne({ id }, doc, { upsert: true })
		return doc
	}

	private projectStatus(id: string, status: TelegramBotStatus): TelegramStatusDoc {
		const doc: TelegramStatusDoc = {
			id,
			accountId: id,
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
		return doc
	}

	private currentStatus(id: string): TelegramStatusDoc {
		const existing = this.status?.findOne({ id })
		if (existing) return existing
		return this.projectStatus(id, this.bot(id).$.status)
	}

	private kv() {
		return this.ctx.vault.namespace(VAULT_NAMESPACE).kv()
	}

	private configStore(): TokenBotConfigStore {
		if (!this.config) throw new Error('TelegramPlugin is not initialized')
		return this.config
	}
}

function maskSecret(value?: string): string | null {
	if (!value) return null
	return value.length <= 8 ? '••••••••' : `${value.slice(0, 4)}••••${value.slice(-4)}`
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

declare module '@pluxel/runtime/web' {
	interface ExtensionUiRpcMap {
		TelegramPlugin: TelegramAdapterRpc
	}

	interface ExtensionUiSignalDbMap {
		TelegramPlugin: {
			settings: TelegramSettingsDoc
			status: TelegramStatusDoc
		}
	}
}
