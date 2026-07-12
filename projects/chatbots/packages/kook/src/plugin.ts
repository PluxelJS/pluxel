import '@pluxel/runtime/register/static'
import '@pluxel/runtime/services/vault'
import { BasePlugin, Plugin } from '@pluxel/runtime'
import type { ExtensionUiRpcMap as _ExtensionUiRpcMap } from '@pluxel/runtime/web'
import { ui, type ManagementStateCollection } from '@pluxel/runtime/web-management'
import {
	ChatHubPlugin,
	TokenBotConfigStore,
	createCapabilityRef,
	createBotRegistry,
	type BotRegistry,
	type BotRegistryController,
	type TokenBotConfigInput,
} from '@repo/chatbots-hub'
import type { KookAutoApi, Result } from './api/types.ts'
import { KookBot, type KookBotStatus } from './bot.ts'
import { KookPluginEvents, type KookEventHandler } from './events.ts'
import type { KookSettingsDoc, KookStatusDoc } from './protocol.ts'
import { KookAdapterRpc } from './rpc.ts'

export type KookBotConfigInput = TokenBotConfigInput

const pluginUi = ui(import.meta.url, './ui/index.tsx')
const VAULT_NAMESPACE = 'KookAdapterPlugin'
const LEGACY_TOKEN = 'bot.token'
const LEGACY_API_BASE = 'api.base_url'
const DEFAULT_API_BASE = 'https://www.kookapp.cn'
const DEFAULT_BOT_ID = 'default'

@Plugin({ name: 'KookAdapterPlugin', startTimeoutMs: 10_000 })
export class KookAdapterPlugin extends BasePlugin {
	private settings?: ManagementStateCollection<KookSettingsDoc>
	private status?: ManagementStateCollection<KookStatusDoc>
	private config?: TokenBotConfigStore
	private readonly hubBinding = createCapabilityRef<
		Pick<ChatHubPlugin, 'registerTransport' | 'receive'>
	>({
		onObserverError: (error) =>
			this.ctx.logger.warn('KOOK ChatHub binding observer failed', { error }),
	})
	private readonly registryState = createBotRegistry<KookBot>({
		onObserverError: (error) =>
			this.ctx.logger.warn('KOOK Bot registry observer failed', { error }),
	})
	private readonly registryController: BotRegistryController<KookBot> =
		this.registryState.controller
	private readonly botDisposers = new Map<string, () => void>()

	/** Live read-only platform capability registry. */
	readonly bots: BotRegistry<KookBot> = this.registryState.registry
	readonly events = new KookPluginEvents()

	override async init(): Promise<void> {
		this.ctx.effects.defer(
			this.plugins.use(ChatHubPlugin, (hub) => {
				this.hubBinding.controller.set(hub)
				return () => this.hubBinding.controller.set(undefined)
			}),
		)
		await this.ctx.webManagement.use(async (web) => {
			this.settings = web.state.collection<KookSettingsDoc>({ name: 'settings' })
			this.status = web.state.collection<KookStatusDoc>({ name: 'status' })
			await Promise.all([this.settings.ready(), this.status.ready()])
			web.ui.register(pluginUi)
			web.rpc.expose(() => new KookAdapterRpc(this))
		})
		this.settings?.removeMany({})
		this.status?.removeMany({})
		this.config = new TokenBotConfigStore(this.kv(), {
			defaultApiBase: DEFAULT_API_BASE,
			legacyTokenKey: LEGACY_TOKEN,
			legacyApiBaseKey: LEGACY_API_BASE,
		})
		if (await this.config.migrateLegacy()) await this.ctx.vault.flush()
		for (const id of await this.config.list()) {
			const stored = await this.config.read(id)
			if (!stored) continue
			const bot = this.installBot(id, stored.token, stored.apiBase)
			this.projectSettings(id, stored)
			void bot.$.start().catch((): void => undefined)
		}
		this.ctx.effects.defer(() => this.destroyAllBots())
	}

	bot(id = DEFAULT_BOT_ID): KookBot {
		return this.bots.require(id)
	}

	async upsertBot(input: KookBotConfigInput): Promise<KookSettingsDoc> {
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

	async testBot(id = DEFAULT_BOT_ID): Promise<{ ok: boolean; message: string }> {
		try {
			const identity = unwrap(await this.bot(id).getUserMe())
			return { ok: true, message: `KOOK Bot ${identity.username ?? identity.id} 鉴权成功。` }
		} catch (error) {
			return { ok: false, message: errorMessage(error) }
		}
	}

	async reconnectBot(id = DEFAULT_BOT_ID): Promise<KookStatusDoc> {
		await this.bot(id).$.start()
		return this.currentStatus(id)
	}

	disconnectBot(id = DEFAULT_BOT_ID): KookStatusDoc {
		this.bot(id).$.stop()
		return this.currentStatus(id)
	}

	registerEventHandler(id: string, handler: KookEventHandler): () => void {
		return this.events.observe(id, ({ event, signal }) => handler(event, signal))
	}

	/** @deprecated Prefer `upsertBot({ id, ... })`. */
	saveSettings(input: { token?: string; apiBase?: string }): Promise<KookSettingsDoc> {
		return this.upsertBot({ id: DEFAULT_BOT_ID, ...input })
	}

	/** @deprecated Prefer `removeBot(id)`. */
	clearToken(): Promise<{ ok: true }> {
		return this.removeBot(DEFAULT_BOT_ID)
	}

	/** @deprecated Prefer `testBot(id)`. */
	testConnection(): Promise<{ ok: boolean; message: string }> {
		return this.testBot(DEFAULT_BOT_ID)
	}

	/** @deprecated Prefer `reconnectBot(id)`. */
	reconnect(): Promise<KookStatusDoc> {
		return this.reconnectBot(DEFAULT_BOT_ID)
	}

	/** @deprecated Prefer `disconnectBot(id)`. */
	disconnect(): KookStatusDoc {
		return this.disconnectBot(DEFAULT_BOT_ID)
	}

	/** @deprecated Prefer `bots.require(id)` and call native methods on the Bot. */
	requireApi(): KookAutoApi {
		return this.bot()
	}

	private installBot(id: string, token: string, apiBase: string): KookBot {
		this.removeRuntimeBot(id)
		const bot = new KookBot({
			id,
			token,
			baseUrl: apiBase,
			hub: this.hubBinding.ref,
			logger: this.ctx.logger,
			onStatus: (next) => this.projectStatus(id, next),
			onEvent: async (sourceBot, event, signal) =>
				this.events.dispatch({ bot: sourceBot, event, signal }, (handler, error) =>
					this.ctx.logger.warn('KOOK plugin event handler failed', { handler, error }),
				),
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
	): KookSettingsDoc {
		const doc: KookSettingsDoc = {
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

	private projectStatus(id: string, status: KookBotStatus): KookStatusDoc {
		const doc: KookStatusDoc = {
			id,
			accountId: id,
			phase: status.phase === 'destroyed' ? 'offline' : status.phase,
			botId: status.botId,
			username: status.username,
			lastError: status.lastError,
			updatedAt: status.updatedAt,
		}
		this.status?.replaceOne({ id }, doc, { upsert: true })
		return doc
	}

	private currentStatus(id: string): KookStatusDoc {
		const existing = this.status?.findOne({ id })
		if (existing) return existing
		return this.projectStatus(id, this.bot(id).$.status)
	}

	private kv() {
		return this.ctx.vault.namespace(VAULT_NAMESPACE).kv()
	}

	private configStore(): TokenBotConfigStore {
		if (!this.config) throw new Error('KookAdapterPlugin is not initialized')
		return this.config
	}
}

/** Target name for new platform-specific dependencies. */
export { KookAdapterPlugin as KookPlugin }

function unwrap<Value>(result: Result<Value>): Value {
	if (result.ok === true) return result.data
	const failure = result as Extract<Result<Value>, { ok: false }>
	throw new Error(`KOOK API error ${failure.code}: ${failure.message}`)
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
		KookAdapterPlugin: KookAdapterRpc
	}

	interface ExtensionUiSignalDbMap {
		KookAdapterPlugin: {
			settings: KookSettingsDoc
			status: KookStatusDoc
		}
	}
}
