// 展示型插件：自定义 UI 扩展 + 路由 + standalone frame + RPC + SSE（带持久化 state）。

import { fileURLToPath } from 'node:url'
import { BasePlugin, Plugin } from '@pluxel/runtime'
import { ui } from '@pluxel/hmr/plugin'
import { RpcTarget } from '@pluxel/runtime/capnweb'
import type { SseChannel } from '@pluxel/runtime/services'

type PluginWithUIStatusDoc = PluginWithUIStatus & { id: 'status' }
const STATUS_DOC_ID = 'status' as const
const MAX_EVENT_SCAN = 200
const MAX_EVENT_HISTORY = 80
const TRIMMED_EVENT_HISTORY = 50

export type DemoEvent = {
	id: string
	kind: 'system' | 'note' | 'counter'
	message: string
	at: number
}

export type PluginWithUIStatus = {
	pluginName: string
	startedAt: number
	counter: number
	eventCount: number
}

export type PluginWithUISsePayload =
	| { type: 'ready'; startedAt: number }
	| { type: 'tick'; now: number }
	| { type: 'activity'; message: string }

const pluginUi = ui(fileURLToPath(new URL('./PluginWithUI/ui/index.tsx', import.meta.url)))

@Plugin({ name: 'PluginWithUI' })
export class PluginWithUI extends BasePlugin {
	private startedAt = Date.now()

	private status = this.ctx.ext.signaldb.collection<PluginWithUIStatusDoc>({
		name: 'status',
	})
	private events = this.ctx.ext.signaldb.collection<DemoEvent>({
		name: 'events',
	})

	private eventSeq = 1
	private channels = new Set<SseChannel>()

	override async init() {
		this.startedAt = Date.now()

		await this.initState()

		pluginUi.bind(this.ctx)
		this.ctx.ext.rpc.expose(() => new PluginWithUIRpc(this))
		this.ctx.ext.sse.expose(() => this.attachSse())

		this.ctx.logger.info('ready')
	}

	private attachSse() {
		return (channel: SseChannel) => {
			this.channels.add(channel)

			channel.emit('ready', { type: 'ready', startedAt: this.startedAt })

			const timer = setInterval(() => {
				channel.emit('tick', { type: 'tick', now: Date.now() })
			}, 1000)

			channel.onAbort(() => {
				clearInterval(timer)
				this.channels.delete(channel)
			})

			return () => {
				clearInterval(timer)
				this.channels.delete(channel)
			}
		}
	}

	private broadcast(payload: PluginWithUISsePayload) {
		for (const ch of this.channels) {
			try {
				ch.emit(payload.type, payload)
			} catch {}
		}
	}

	private async initState() {
		await Promise.all([this.status.ready(), this.events.ready()])

		const existingList = this.events.find({}, { limit: MAX_EVENT_SCAN })
		const maxId = existingList.reduce((acc, e) => Math.max(acc, Number(e.id) || 0), 0)
		this.eventSeq = Math.max(maxId, 0) + 1

		this.syncStatus({
			counter: this.getStatusDoc()?.counter ?? 0,
			eventCount: existingList.length,
		})

		if (existingList.length === 0)
			this.appendEvent('system', 'UI 扩展已加载：RPC/SSE/Routes/Tabs 都已就绪。')
		else this.syncStatus()
	}

	getStatus() {
		const status = this.getStatusDoc()
		return {
			pluginName: status?.pluginName ?? this.ctx.pluginInfo.id,
			startedAt: status?.startedAt ?? this.startedAt,
			counter: status?.counter ?? 0,
			eventCount: status?.eventCount ?? this.events.count(),
		}
	}

	listEvents(limit = 50): DemoEvent[] {
		const capped = Math.max(0, Math.min(MAX_EVENT_SCAN, Math.floor(limit)))
		const docs = this.events.find({}, { limit: capped, sort: { at: -1 } })
		return docs.slice(0, capped).map((event: DemoEvent) => Object.assign({}, event))
	}

	appendEvent(kind: DemoEvent['kind'], message: string): DemoEvent {
		const trimmed = message.trim()
		if (!trimmed) throw new Error('消息不能为空')

		let nextId = this.eventSeq
		while (this.events.findOne({ id: String(nextId) })) {
			nextId += 1
		}
		this.eventSeq = nextId + 1
		const event: DemoEvent = {
			id: String(nextId),
			kind,
			message: trimmed,
			at: Date.now(),
		}

		this.events.insert(event)

		const all = this.events.find({}, { sort: { at: 1 } })
		if (all.length > MAX_EVENT_HISTORY) {
			const sorted = all.slice(0, Math.max(0, all.length - TRIMMED_EVENT_HISTORY))
			for (const old of sorted) {
				this.events.removeOne({ id: old.id })
			}
		}

		this.syncStatus()
		this.broadcast({ type: 'activity', message: `event:${kind}` })
		return { ...event }
	}

	increment(delta = 1) {
		const n = Number.isFinite(delta) ? Math.trunc(delta) : 1
		const current = this.getStatusDoc()?.counter ?? 0
		const next = current + (n === 0 ? 1 : n)
		this.syncStatus({ counter: next })
		this.appendEvent('counter', `计数器变更：${current} → ${next}`)
		return { counter: next }
	}

	resetCounter() {
		const current = this.getStatusDoc()?.counter ?? 0
		this.syncStatus({ counter: 0 })
		this.appendEvent('counter', `计数器重置：${current} → 0`)
		return { counter: 0 }
	}

	clearEvents() {
		this.events.removeMany({})
		this.syncStatus()
		this.broadcast({ type: 'activity', message: 'events:cleared' })
		this.appendEvent('system', '事件已清空')
		return { ok: true }
	}

	private getStatusDoc() {
		return this.status.findOne({ id: STATUS_DOC_ID })
	}

	private buildStatusDoc(
		input: {
			counter?: number
			eventCount?: number
		} = {},
	): PluginWithUIStatusDoc {
		const current = this.getStatusDoc()
		return {
			id: STATUS_DOC_ID,
			pluginName: this.ctx.pluginInfo.id,
			startedAt: this.startedAt,
			counter: input.counter ?? current?.counter ?? 0,
			eventCount: input.eventCount ?? this.events.count(),
		}
	}

	private syncStatus(override: Partial<Omit<PluginWithUIStatusDoc, 'id'>> = {}) {
		const next = this.buildStatusDoc({
			counter: override.counter,
			eventCount: override.eventCount,
		})
		this.status.replaceOne({ id: STATUS_DOC_ID }, next, { upsert: true })
	}
}

export class PluginWithUIRpc extends RpcTarget {
	constructor(private readonly plugin: PluginWithUI) {
		super()
	}

	status() {
		return this.plugin.getStatus()
	}

	addNote(message: string) {
		return Promise.resolve(this.plugin.appendEvent('note', message))
	}

	increment(delta?: number) {
		return Promise.resolve(this.plugin.increment(typeof delta === 'number' ? delta : 1))
	}

	resetCounter() {
		return Promise.resolve(this.plugin.resetCounter())
	}

	clearEvents() {
		return Promise.resolve(this.plugin.clearEvents())
	}
}

declare module '@pluxel/runtime/web/ui' {
	interface ExtensionUiRpcMap {
		PluginWithUI: PluginWithUIRpc
	}

	interface ExtensionUiSseMap {
		PluginWithUI: PluginWithUISsePayload
	}

	interface ExtensionUiSignalDbMap {
		PluginWithUI: {
			status: PluginWithUIStatusDoc
			events: DemoEvent
		}
	}
}
