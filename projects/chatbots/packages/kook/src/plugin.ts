import { BasePlugin, Plugin } from '@pluxel/runtime'
import type { VaultServiceConfig as _VaultServiceConfig } from '@pluxel/runtime/services/vault'
import { workbench, type MountedWorkbenchCollections } from '@pluxel/runtime/workbench'
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
import { KookBot } from './bot.ts'
import { createKookPluginEvents } from './events.factory.ts'
import { KookWorkbenchRpc } from './workbench.ts'
import type { KookSettingsDoc, KookStatusDoc } from './workbench-contract.ts'
import type { KookBotStatus } from './status.ts'
import type { KookEvent } from './protocol.ts'
import { KookWorkbench } from './workbench-extension.ts'

export type KookBotConfigInput = BotAccountInput
export type KookEventProjection = AcknowledgedProjection<KookBot, KookEvent>

const VAULT_NAMESPACE = 'KookPlugin'
const DEFAULT_API_BASE = 'https://www.kookapp.cn'

@Plugin({ name: 'KookPlugin', startTimeoutMs: 10_000 })
export class KookPlugin extends BasePlugin {
	private settings?: MountedWorkbenchCollections<typeof KookWorkbench>['settings']
	private status?: MountedWorkbenchCollections<typeof KookWorkbench>['status']
	private accounts?: BotAccountStore
	private readonly registryState = createBotRegistry<KookBot>({
		onObserverError: (error) =>
			this.ctx.logger.warn('KOOK Bot registry observer failed', { error }),
	})
	private readonly registryController: BotRegistryController<KookBot> =
		this.registryState.controller
	private readonly botDisposers = new Map<string, () => void>()
	private readonly accountMutations = new KeyedSerialExecutor<string>()
	private readonly eventProjections = new AcknowledgedProjectionRegistry<KookBot, KookEvent>(
		'KOOK event projection',
	)

	/** Live read-only platform capability registry. */
	readonly bots: BotRegistry<KookBot> = this.registryState.registry
	readonly events = createKookPluginEvents(this.ctx)

	override async init(): Promise<void> {
		const mounted = this.ctx.workbench.mount(KookWorkbench, {
			commands: workbench.provide.rpc(() => new KookWorkbenchRpc(this)),
			settings: workbench.provide.collection(),
			status: workbench.provide.collection(),
		})
		if (mounted) {
			this.settings = mounted.collections.settings
			this.status = mounted.collections.status
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

	bot(id: string): KookBot {
		return this.bots.require(id)
	}

	/** Registers an acknowledged native-event projection. Failure keeps the gateway SN unchanged. */
	registerEventProjection(id: string, project: KookEventProjection): () => void {
		return this.eventProjections.register(id, project)
	}

	async upsertBot(input: KookBotConfigInput): Promise<KookBot> {
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

	async reconnectBot(id: string): Promise<KookBotStatus> {
		const normalized = normalizeBotId(id)
		return this.accountMutations.run(normalized, async () => {
			return this.bot(normalized).$.start()
		})
	}

	disconnectBot(id: string): Promise<KookBotStatus> {
		const normalized = normalizeBotId(id)
		return this.accountMutations.run(normalized, async () => {
			return this.bot(normalized).$.stop()
		})
	}

	private installBot(id: string, token: string, apiBase: string): KookBot {
		this.removeRuntimeBot(id)
		const bot = new KookBot({
			id,
			ctx: this.ctx,
			token,
			baseUrl: apiBase,
			pluginEvents: this.events,
			projectEvent: (source, event, signal) => this.projectEvent(source, event, signal),
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

	private async projectEvent(bot: KookBot, event: KookEvent, signal: AbortSignal): Promise<void> {
		await this.eventProjections.dispatch(bot, event, signal)
	}

	private projectSettings(id: string, stored: BotAccountConfig): void {
		const doc: KookSettingsDoc = {
			id,
			tokenPreview: maskSecret(stored.token),
			apiBase: stored.apiBase,
			updatedAt: Date.now(),
		}
		this.settings?.replaceOne({ id }, doc, { upsert: true })
	}

	private projectStatus(id: string, status: KookBotStatus): void {
		const doc: KookStatusDoc = {
			id,
			phase: status.phase === 'destroyed' ? 'offline' : status.phase,
			botId: status.botId,
			username: status.username,
			lastError: status.lastError,
			startedAt: status.startedAt,
			connectedAt: status.connectedAt,
			gatewayPhase: status.gateway.phase,
			lastSequence: status.gateway.lastSequence,
			bufferedEvents: status.gateway.bufferedEvents,
			lastEventAt: status.gateway.timestamps.lastEventAt,
			reconnectAttempts: status.gateway.counters.reconnectAttempts,
			resumeAttempts: status.gateway.counters.resumeAttempts,
			duplicateEvents: status.gateway.counters.duplicateEvents,
			outOfOrderEvents: status.gateway.counters.outOfOrderEvents,
			bufferOverflows: status.gateway.counters.bufferOverflows,
			currentBackoffMs: status.gateway.currentBackoffMs,
			updatedAt: status.updatedAt,
		}
		this.status?.replaceOne({ id }, doc, { upsert: true })
	}

	private kv() {
		return this.ctx.vault.namespace(VAULT_NAMESPACE).kv()
	}

	private accountStore(): BotAccountStore {
		if (!this.accounts) throw new Error('KookPlugin is not initialized')
		return this.accounts
	}
}

function maskSecret(value: string): string {
	return value.length <= 8 ? '••••••••' : `${value.slice(0, 4)}••••${value.slice(-4)}`
}
