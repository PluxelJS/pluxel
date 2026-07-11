import { setTimeout as delay } from 'node:timers/promises'
import '@pluxel/runtime/register/static'
import '@pluxel/runtime/services/vault'
import { BasePlugin, Plugin, setParamToken } from '@pluxel/runtime'
import { RpcTarget } from '@pluxel/runtime/capnweb'
import { ui, type ManagementStateCollection } from '@pluxel/runtime/web-management'
import type { ExtensionUiRpcMap as _ExtensionUiRpcMap } from '@pluxel/runtime/web'
import {
	ChatHubPlugin,
	contentText,
	normalizeContent,
	type ChatMessage,
	type ChatSendRequest,
} from '@repo/chatbots-hub'

const pluginUi = ui(import.meta.url, './ui/index.tsx')
const VAULT_NAMESPACE = 'TelegramAdapterPlugin'
const KV_TOKEN = 'bot.token'
const KV_API_BASE = 'api.base_url'
const DEFAULT_API_BASE = 'https://api.telegram.org'

export type TelegramSettingsDoc = {
	id: 'settings'
	hasToken: boolean
	tokenPreview: string | null
	apiBase: string
	updatedAt: number
}

export type TelegramStatusDoc = {
	id: 'status'
	phase: 'unconfigured' | 'offline' | 'connecting' | 'online' | 'error'
	botId: string | null
	username: string | null
	lastError: string | null
	updatedAt: number
}

type TelegramUser = {
	id: number
	is_bot?: boolean
	first_name?: string
	last_name?: string
	username?: string
}
type TelegramChat = {
	id: number
	type: 'private' | 'group' | 'supergroup' | 'channel'
	title?: string
}
type TelegramMessage = {
	message_id: number
	date: number
	chat: TelegramChat
	from?: TelegramUser
	text?: string
	caption?: string
}
type TelegramUpdate = {
	update_id: number
	message?: TelegramMessage
	channel_post?: TelegramMessage
}

type TelegramResponse<T> = { ok: boolean; result?: T; description?: string }

@Plugin({ name: 'TelegramAdapterPlugin' })
export class TelegramAdapterPlugin extends BasePlugin {
	private settings?: ManagementStateCollection<TelegramSettingsDoc>
	private status?: ManagementStateCollection<TelegramStatusDoc>
	private token = ''
	private apiBase = DEFAULT_API_BASE
	private pollingTimeoutSeconds = 25
	private offset = 0
	private controller?: AbortController
	private disposeTransport?: () => void

	constructor(private readonly hub: ChatHubPlugin) {
		super()
	}

	override async init(): Promise<void> {
		await this.ctx.webManagement.use(async (web) => {
			this.settings = web.state.collection<TelegramSettingsDoc>({ name: 'settings' })
			this.status = web.state.collection<TelegramStatusDoc>({ name: 'status' })
			await Promise.all([this.settings.ready(), this.status.ready()])
			web.ui.register(pluginUi)
			web.rpc.expose(() => new TelegramAdapterRpc(this))
		})
		await this.syncSettingsDoc()
		this.ensureStatusDoc()
		this.ctx.effects.defer(() => this.stopConnection())
		if (await this.hasToken()) void this.reconnect().catch((error) => this.setError(error))
	}

	async saveSettings(input: { token?: string; apiBase?: string }): Promise<TelegramSettingsDoc> {
		const kv = this.kv()
		if (input.token?.trim()) await kv.set(KV_TOKEN, input.token.trim())
		await kv.set(KV_API_BASE, normalizeBaseUrl(input.apiBase, DEFAULT_API_BASE))
		await this.ctx.vault.flush()
		const settings = await this.syncSettingsDoc()
		await this.reconnect()
		return settings
	}

	async clearToken(): Promise<TelegramSettingsDoc> {
		await this.kv().delete(KV_TOKEN)
		await this.ctx.vault.flush()
		this.stopConnection()
		this.token = ''
		this.setStatus('unconfigured', { resetIdentity: true })
		return this.syncSettingsDoc()
	}

	async testConnection(): Promise<{ ok: boolean; message: string }> {
		try {
			const identity = await this.authenticate()
			this.setStatus('offline', { botId: String(identity.id), username: identity.username ?? '' })
			return { ok: true, message: `Telegram Bot @${identity.username ?? identity.id} 鉴权成功。` }
		} catch (error) {
			this.setError(error)
			return { ok: false, message: errorMessage(error) }
		}
	}

	async reconnect(): Promise<TelegramStatusDoc> {
		this.stopConnection()
		this.setStatus('connecting')
		const identity = await this.authenticate()
		this.disposeTransport = this.hub.registerTransport({
			name: 'telegram',
			send: (request, signal) => this.send(request, signal),
		})
		this.controller = new AbortController()
		void this.poll(this.controller.signal)
		return this.setStatus('online', {
			botId: String(identity.id),
			username: identity.username ?? '',
		})
	}

	disconnect(): TelegramStatusDoc {
		this.stopConnection()
		return this.setStatus(this.token ? 'offline' : 'unconfigured')
	}

	private async poll(signal: AbortSignal): Promise<void> {
		while (!signal.aborted) {
			try {
				const updates = await this.call<TelegramUpdate[]>(
					'getUpdates',
					{
						offset: this.offset,
						timeout: this.pollingTimeoutSeconds,
						allowed_updates: ['message', 'channel_post'],
					},
					signal,
				)
				const messages: ChatMessage[] = []
				for (const update of updates) {
					this.offset = Math.max(this.offset, update.update_id + 1)
					const message = this.normalize(update)
					if (message) messages.push(message)
				}
				await Promise.all(messages.map((message) => this.hub.receive(message, signal)))
			} catch (error) {
				if (signal.aborted) return
				this.ctx.logger.warn('Telegram polling failed; retrying', { error })
				await delay(2_000, undefined, { signal }).catch((): void => undefined)
			}
		}
	}

	private normalize(update: TelegramUpdate): ChatMessage | undefined {
		const source = update.message ?? update.channel_post
		if (!source) return undefined
		const text = source.text ?? source.caption ?? ''
		if (!text) return undefined
		const actor = source.from ?? { id: source.chat.id, first_name: source.chat.title }
		return {
			id: String(source.message_id),
			transport: 'telegram',
			conversation: {
				id: String(source.chat.id),
				kind:
					source.chat.type === 'private'
						? 'direct'
						: source.chat.type === 'channel'
							? 'channel'
							: 'group',
				title: source.chat.title,
			},
			actor: {
				id: String(actor.id),
				displayName:
					[actor.first_name, actor.last_name].filter(Boolean).join(' ') || actor.username,
				username: actor.username,
				isBot: actor.is_bot,
			},
			content: [{ type: 'text', text }],
			text,
			createdAt: source.date * 1_000,
			metadata: { updateId: update.update_id },
		}
	}

	private async send(request: ChatSendRequest, signal?: AbortSignal) {
		const text = contentText(normalizeContent(request.content))
		if (!text) throw new Error('Telegram adapter currently requires text-compatible content')
		const sent = await this.call<TelegramMessage>(
			'sendMessage',
			{
				chat_id: request.conversationId,
				text,
				...(request.replyToId
					? { reply_parameters: { message_id: Number(request.replyToId) } }
					: {}),
			},
			signal,
		)
		return { messageId: String(sent.message_id) }
	}

	private async call<T>(method: string, body: unknown, signal?: AbortSignal): Promise<T> {
		const response = await fetch(`${this.apiBase.replace(/\/$/, '')}/bot${this.token}/${method}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
			signal,
		})
		const payload = (await response.json()) as TelegramResponse<T>
		if (!response.ok || !payload.ok || payload.result === undefined) {
			throw new Error(
				`Telegram ${method} failed (${response.status}): ${payload.description ?? 'unknown error'}`,
			)
		}
		return payload.result
	}

	private async authenticate(): Promise<TelegramUser> {
		const stored = await this.readStoredSettings()
		if (!stored.token) throw new Error('请先在 Telegram 设置页保存 Bot Token')
		this.token = stored.token
		this.apiBase = stored.apiBase
		return this.call<TelegramUser>('getMe', {})
	}

	private stopConnection(): void {
		this.controller?.abort()
		this.controller = undefined
		this.disposeTransport?.()
		this.disposeTransport = undefined
	}

	private kv() {
		return this.ctx.vault.namespace(VAULT_NAMESPACE).kv()
	}

	private async hasToken(): Promise<boolean> {
		return Boolean(await this.kv().get<string>(KV_TOKEN))
	}

	private async readStoredSettings(): Promise<{ token?: string; apiBase: string }> {
		const kv = this.kv()
		return {
			token: await kv.get<string>(KV_TOKEN),
			apiBase: (await kv.get<string>(KV_API_BASE)) ?? DEFAULT_API_BASE,
		}
	}

	private async syncSettingsDoc(): Promise<TelegramSettingsDoc> {
		const stored = await this.readStoredSettings()
		const doc: TelegramSettingsDoc = {
			id: 'settings',
			hasToken: Boolean(stored.token),
			tokenPreview: maskSecret(stored.token),
			apiBase: stored.apiBase,
			updatedAt: Date.now(),
		}
		this.settings?.replaceOne({ id: 'settings' }, doc, { upsert: true })
		return doc
	}

	private ensureStatusDoc(): void {
		if (this.status && !this.status.findOne({ id: 'status' })) this.setStatus('unconfigured')
	}

	private setStatus(
		phase: TelegramStatusDoc['phase'],
		options: { botId?: string; username?: string; resetIdentity?: boolean } = {},
	): TelegramStatusDoc {
		const current = this.status?.findOne({ id: 'status' })
		const doc: TelegramStatusDoc = {
			id: 'status',
			phase,
			botId: options.resetIdentity ? null : (options.botId ?? current?.botId ?? null),
			username: options.resetIdentity ? null : (options.username ?? current?.username ?? null),
			lastError: null,
			updatedAt: Date.now(),
		}
		this.status?.replaceOne({ id: 'status' }, doc, { upsert: true })
		return doc
	}

	private setError(error: unknown): TelegramStatusDoc {
		const doc = { ...this.setStatus('error'), lastError: errorMessage(error) }
		this.status?.replaceOne({ id: 'status' }, doc, { upsert: true })
		return doc
	}
}

setParamToken(TelegramAdapterPlugin, 0, ChatHubPlugin)

export class TelegramAdapterRpc extends RpcTarget {
	constructor(private readonly plugin: TelegramAdapterPlugin) {
		super()
	}

	saveSettings(input: { token?: string; apiBase?: string }) {
		return this.plugin.saveSettings(input)
	}
	clearToken() {
		return this.plugin.clearToken()
	}
	testConnection() {
		return this.plugin.testConnection()
	}
	reconnect() {
		return this.plugin.reconnect()
	}
	disconnect() {
		return this.plugin.disconnect()
	}
}

function normalizeBaseUrl(value: string | undefined, fallback: string): string {
	return (value?.trim() || fallback).replace(/\/+$/, '')
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
		TelegramAdapterPlugin: TelegramAdapterRpc
	}

	interface ExtensionUiSignalDbMap {
		TelegramAdapterPlugin: {
			settings: TelegramSettingsDoc
			status: TelegramStatusDoc
		}
	}
}
