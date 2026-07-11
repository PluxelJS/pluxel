import '@pluxel/runtime/register/static'
import '@pluxel/runtime/services/vault'
import { BasePlugin, Plugin } from '@pluxel/runtime'
import { RpcTarget } from '@pluxel/runtime/capnweb'
import { ui, type ManagementStateCollection } from '@pluxel/runtime/web-management'
import type { ExtensionUiRpcMap as _ExtensionUiRpcMap } from '@pluxel/runtime/web'
import {
	ChatHubPlugin,
	contentText,
	normalizeContent,
	type ChatBlock,
	type ChatMessage,
	type ChatSendRequest,
} from '@repo/chatbots-hub'
import { createKookClient } from './api/client.ts'
import type { KookApi, Result } from './api/types.ts'

const pluginUi = ui(import.meta.url, './ui/index.tsx')
const VAULT_NAMESPACE = 'KookAdapterPlugin'
const KV_TOKEN = 'bot.token'
const KV_API_BASE = 'api.base_url'
const DEFAULT_API_BASE = 'https://www.kookapp.cn'

export type KookSettingsDoc = {
	id: 'settings'
	hasToken: boolean
	tokenPreview: string | null
	apiBase: string
	updatedAt: number
}

export type KookStatusDoc = {
	id: 'status'
	phase: 'unconfigured' | 'offline' | 'connecting' | 'online' | 'error'
	botId: string | null
	username: string | null
	lastError: string | null
	updatedAt: number
}

export type KookEvent = {
	type: number
	target_id: string
	author_id: string
	content?: string
	msg_id: string
	msg_timestamp: number
	channel_type: 'GROUP' | 'PERSON' | string
	extra?: {
		guild_id?: string
		channel_name?: string
		author?: {
			id?: string
			username?: string
			nickname?: string
			bot?: boolean
		}
		kmarkdown?: { raw_content?: string }
		attachments?: KookAttachment | KookAttachment[]
	}
}

type KookAttachment = {
	type?: 'image' | 'video' | 'audio' | 'file' | string
	url?: string
	name?: string
	file_type?: string
}

type KookGatewayFrame = {
	s: number
	sn?: number
	d?: KookEvent | { code?: number; session_id?: string }
}

const KOOK_TEXT = 1
const KOOK_IMAGE = 2
const KOOK_VIDEO = 3
const KOOK_FILE = 4
const KOOK_KMARKDOWN = 9
const SIGNAL_EVENT = 0
const SIGNAL_HELLO = 1
const SIGNAL_PING = 2
const SIGNAL_PONG = 3
const SIGNAL_RECONNECT = 5

export function normalizeKookEvent(event: KookEvent, botId?: string): ChatMessage | undefined {
	if (!event.msg_id || !event.author_id || event.author_id === botId) return undefined
	const author = event.extra?.author
	if (author?.bot) return undefined

	const blocks: ChatBlock[] = []
	const text = event.extra?.kmarkdown?.raw_content ?? event.content ?? ''
	if (event.type === KOOK_TEXT || event.type === KOOK_KMARKDOWN) {
		if (text) blocks.push({ type: 'text', text })
	} else if (event.type === KOOK_IMAGE && event.content) {
		blocks.push({ type: 'image', url: event.content })
	} else if ((event.type === KOOK_FILE || event.type === KOOK_VIDEO) && event.content) {
		blocks.push({ type: 'file', url: event.content })
	}

	const attachments = event.extra?.attachments
	for (const attachment of attachments
		? Array.isArray(attachments)
			? attachments
			: [attachments]
		: []) {
		if (!attachment.url) continue
		if (attachment.type === 'image') {
			blocks.push({ type: 'image', url: attachment.url, alt: attachment.name })
		} else {
			blocks.push({
				type: 'file',
				url: attachment.url,
				name: attachment.name,
				mediaType: attachment.file_type,
			})
		}
	}
	if (blocks.length === 0) return undefined

	const direct = event.channel_type === 'PERSON'
	return {
		id: event.msg_id,
		transport: 'kook',
		conversation: {
			id: direct ? `direct:${event.author_id}` : `channel:${event.target_id}`,
			kind: direct ? 'direct' : 'channel',
			title: event.extra?.channel_name,
		},
		actor: {
			id: event.author_id,
			displayName: author?.nickname ?? author?.username,
			username: author?.username,
			isBot: author?.bot,
		},
		content: blocks,
		text: contentText(blocks),
		createdAt: normalizeKookTimestamp(event.msg_timestamp),
		metadata: { guildId: event.extra?.guild_id, messageType: event.type },
	}
}

function normalizeKookTimestamp(value: number): number {
	return value > 0 && value < 10_000_000_000 ? value * 1_000 : value
}

export function parseKookConversationId(value: string): { direct: boolean; targetId: string } {
	const separator = value.indexOf(':')
	if (separator <= 0 || separator === value.length - 1) {
		throw new Error(`Invalid KOOK conversation id: ${value}`)
	}
	const kind = value.slice(0, separator)
	if (kind !== 'direct' && kind !== 'channel') {
		throw new Error(`Unsupported KOOK conversation kind: ${kind}`)
	}
	return { direct: kind === 'direct', targetId: value.slice(separator + 1) }
}

@Plugin({ name: 'KookAdapterPlugin', startTimeoutMs: 10_000, dependencies: [ChatHubPlugin] })
export class KookAdapterPlugin extends BasePlugin {
	private settings?: ManagementStateCollection<KookSettingsDoc>
	private status?: ManagementStateCollection<KookStatusDoc>
	private client?: KookApi
	private botId = ''
	private username = ''
	private disposeTransport?: () => void
	private controller?: AbortController
	private socket?: WebSocket
	private heartbeat?: ReturnType<typeof setInterval>
	private lastSequence = 0
	private awaitingPongAt = 0
	private reconnectAttempts = 0
	private reconnectTimer?: ReturnType<typeof setTimeout>

	constructor(private readonly hub: ChatHubPlugin) {
		super()
	}

	override async init(): Promise<void> {
		await this.ctx.webManagement.use(async (web) => {
			this.settings = web.state.collection<KookSettingsDoc>({ name: 'settings' })
			this.status = web.state.collection<KookStatusDoc>({ name: 'status' })
			await Promise.all([this.settings.ready(), this.status.ready()])
			web.ui.register(pluginUi)
			web.rpc.expose(() => new KookAdapterRpc(this))
		})
		await this.syncSettingsDoc()
		this.ensureStatusDoc()
		this.ctx.effects.defer(() => this.shutdown())
		if (await this.hasToken()) void this.reconnect().catch((error) => this.setError(error))
	}

	async saveSettings(input: { token?: string; apiBase?: string }): Promise<KookSettingsDoc> {
		const kv = this.kv()
		if (input.token?.trim()) await kv.set(KV_TOKEN, input.token.trim())
		await kv.set(KV_API_BASE, normalizeBaseUrl(input.apiBase, DEFAULT_API_BASE))
		await this.ctx.vault.flush()
		const settings = await this.syncSettingsDoc()
		await this.reconnect()
		return settings
	}

	async clearToken(): Promise<KookSettingsDoc> {
		await this.kv().delete(KV_TOKEN)
		await this.ctx.vault.flush()
		this.stopConnection()
		this.client = undefined
		this.setStatus('unconfigured', { resetIdentity: true })
		return this.syncSettingsDoc()
	}

	async testConnection(): Promise<{ ok: boolean; message: string }> {
		try {
			const identity = await this.authenticate()
			this.setStatus('offline', { botId: identity.id, username: identity.username ?? '' })
			return { ok: true, message: `KOOK Bot ${identity.username ?? identity.id} 鉴权成功。` }
		} catch (error) {
			this.setError(error)
			return { ok: false, message: errorMessage(error) }
		}
	}

	async reconnect(): Promise<KookStatusDoc> {
		this.stopConnection()
		this.setStatus('connecting')
		const identity = await this.authenticate()
		this.botId = identity.id
		this.username = identity.username ?? identity.nickname ?? ''
		this.disposeTransport = this.hub.registerTransport({
			name: 'kook',
			send: (request, signal) => this.send(request, signal),
		})
		this.controller = new AbortController()
		void this.connect(this.controller.signal)
		return this.setStatus('connecting', { botId: this.botId, username: this.username })
	}

	disconnect(): KookStatusDoc {
		this.stopConnection()
		return this.setStatus(this.client ? 'offline' : 'unconfigured')
	}

	private async connect(signal: AbortSignal): Promise<void> {
		if (signal.aborted) return
		try {
			const gateway = unwrap(await this.requireClient().getGateway({ compress: 0 }))
			if (signal.aborted) return
			this.openSocket(gateway.url, signal)
		} catch (error) {
			if (signal.aborted) return
			this.setError(error)
			this.ctx.logger.warn('KOOK gateway connection failed', { error })
			this.scheduleReconnect(signal)
		}
	}

	private openSocket(url: string, signal: AbortSignal): void {
		this.socket?.close()
		const socket = new WebSocket(url)
		this.socket = socket
		const abort = () => socket.close(1000, 'plugin stopped')
		signal.addEventListener('abort', abort, { once: true })

		socket.addEventListener('message', (message) => {
			void this.handleFrame(message.data, socket, signal)
		})
		socket.addEventListener('error', () => {
			this.ctx.logger.warn('KOOK gateway WebSocket error')
		})
		socket.addEventListener('close', (event) => {
			signal.removeEventListener('abort', abort)
			this.stopHeartbeat()
			if (this.socket === socket) this.socket = undefined
			if (!signal.aborted) {
				this.setStatus('offline', { botId: this.botId, username: this.username })
				this.ctx.logger.warn('KOOK gateway disconnected', {
					code: event.code,
					reason: event.reason,
				})
				this.scheduleReconnect(signal)
			}
		})
	}

	private async handleFrame(raw: unknown, socket: WebSocket, signal: AbortSignal): Promise<void> {
		try {
			const text =
				typeof raw === 'string' ? raw : raw instanceof Blob ? await raw.text() : String(raw)
			const frame = JSON.parse(text) as KookGatewayFrame
			if (frame.s === SIGNAL_HELLO) {
				const hello = frame.d as { code?: number; session_id?: string } | undefined
				if (hello?.code !== 0) {
					this.ctx.logger.warn('KOOK gateway rejected session', { code: hello?.code })
					socket.close(4000, 'gateway hello rejected')
					return
				}
				this.reconnectAttempts = 0
				this.startHeartbeat(socket)
				this.setStatus('online', { botId: this.botId, username: this.username })
				this.ctx.logger.info('KOOK gateway online', { sessionId: hello.session_id })
				return
			}
			if (frame.s === SIGNAL_PONG) {
				this.awaitingPongAt = 0
				return
			}
			if (frame.s === SIGNAL_RECONNECT) {
				socket.close(4001, 'gateway requested reconnect')
				return
			}
			if (frame.s !== SIGNAL_EVENT || !frame.d) return
			this.lastSequence = Math.max(this.lastSequence, frame.sn ?? 0)
			const normalized = normalizeKookEvent(frame.d as KookEvent, this.botId)
			if (normalized) await this.hub.receive(normalized, signal)
		} catch (error) {
			if (!signal.aborted) this.ctx.logger.warn('Failed to process KOOK gateway frame', { error })
		}
	}

	private startHeartbeat(socket: WebSocket): void {
		this.stopHeartbeat()
		this.heartbeat = setInterval(() => {
			if (socket.readyState !== WebSocket.OPEN) return
			if (this.awaitingPongAt && Date.now() - this.awaitingPongAt > 10_000) {
				socket.close(4002, 'heartbeat timeout')
				return
			}
			this.awaitingPongAt = Date.now()
			socket.send(JSON.stringify({ s: SIGNAL_PING, sn: this.lastSequence }))
		}, 30_000)
	}

	private stopHeartbeat(): void {
		if (this.heartbeat) clearInterval(this.heartbeat)
		this.heartbeat = undefined
		this.awaitingPongAt = 0
	}

	private scheduleReconnect(signal: AbortSignal): void {
		if (signal.aborted || this.reconnectTimer) return
		const delayMs = Math.min(60_000, 1_000 * 2 ** Math.min(this.reconnectAttempts++, 6))
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = undefined
			void this.connect(signal)
		}, delayMs)
	}

	private async send(request: ChatSendRequest, signal?: AbortSignal) {
		const target = parseKookConversationId(request.conversationId)
		const blocks = normalizeContent(request.content)
		let lastMessageId = ''
		for (const block of blocks) {
			if (signal?.aborted) throw signal.reason
			const payload = {
				target_id: target.targetId,
				...this.outboundBlock(block),
				...(request.replyToId ? { quote: request.replyToId } : {}),
			}
			const sent = target.direct
				? unwrap(await this.requireClient().createDirectMessage(payload))
				: unwrap(await this.requireClient().sendMessage(payload))
			lastMessageId = sent.msg_id
		}
		if (!lastMessageId) throw new Error('KOOK send requires non-empty content')
		return { messageId: lastMessageId }
	}

	private outboundBlock(block: ChatBlock): { type: number; content: string } {
		if (block.type === 'text') return { type: KOOK_TEXT, content: block.text }
		if (block.type === 'image') return { type: KOOK_IMAGE, content: block.url }
		return { type: KOOK_FILE, content: block.url }
	}

	private shutdown(): void {
		this.stopConnection()
	}

	private stopConnection(): void {
		this.controller?.abort()
		this.controller = undefined
		this.disposeTransport?.()
		this.disposeTransport = undefined
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
		this.reconnectTimer = undefined
		this.stopHeartbeat()
		this.socket?.close(1000, 'plugin stopped')
		this.socket = undefined
	}

	private async authenticate() {
		const stored = await this.readStoredSettings()
		if (!stored.token) throw new Error('请先在 KOOK 设置页保存 Bot Token')
		this.client = createKookClient({ token: stored.token, baseUrl: stored.apiBase })
		return unwrap(await this.client.getUserMe())
	}

	private requireClient(): KookApi {
		if (!this.client) throw new Error('KOOK client is not configured')
		return this.client
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

	private async syncSettingsDoc(): Promise<KookSettingsDoc> {
		const stored = await this.readStoredSettings()
		const doc: KookSettingsDoc = {
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
		phase: KookStatusDoc['phase'],
		options: { botId?: string; username?: string; resetIdentity?: boolean } = {},
	): KookStatusDoc {
		const current = this.status?.findOne({ id: 'status' })
		const doc: KookStatusDoc = {
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

	private setError(error: unknown): KookStatusDoc {
		const doc = { ...this.setStatus('error'), lastError: errorMessage(error) }
		this.status?.replaceOne({ id: 'status' }, doc, { upsert: true })
		return doc
	}
}

export class KookAdapterRpc extends RpcTarget {
	constructor(private readonly plugin: KookAdapterPlugin) {
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

function unwrap<T>(result: Result<T>): T {
	if (result.ok === true) return result.data
	const failure = result as Extract<Result<T>, { ok: false }>
	throw new Error(`KOOK API error ${failure.code}: ${failure.message}`)
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
		KookAdapterPlugin: KookAdapterRpc
	}

	interface ExtensionUiSignalDbMap {
		KookAdapterPlugin: {
			settings: KookSettingsDoc
			status: KookStatusDoc
		}
	}
}
