// Read this when:
// - 你要写自定义 UI
// - 你想看 server 侧 `ui(...).bind(this.ctx)` + RPC + SSE + SignalDB 的最小闭环

import { fileURLToPath } from 'node:url'
import { BasePlugin, Plugin } from '@pluxel/runtime'
import { ui } from '@pluxel/hmr/plugin'
import { RpcTarget } from '@pluxel/runtime/capnweb'
import type { SseChannel } from '@pluxel/runtime/services'

// Shared server-side data model exposed to the UI.
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

// Keep UI entry declaration near the model so readers see the server/UI boundary early.
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
		this.registerUiBindings()

		this.ctx.logger.info('ready')
	}

	private registerUiBindings() {
		pluginUi.bind(this.ctx)
		this.ctx.ext.rpc.expose(() => new PluginWithUIRpc(this))
		this.ctx.ext.sse.expose(() => this.attachSse())
	}

	// SSE lifecycle.
	private attachSse() {
		return (channel: SseChannel) => {
			this.channels.add(channel)

			channel.emit('ready', { type: 'ready', startedAt: this.startedAt })

			const timer = setInterval(() => {
				channel.emit('tick', { type: 'tick', now: Date.now() })
			}, 1000)

			const cleanup = () => {
				clearInterval(timer)
				this.channels.delete(channel)
			}

			channel.onAbort(cleanup)

			return cleanup
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

		if (existingList.length === 0) {
			this.appendEvent('system', 'UI 扩展已加载：RPC/SSE/Routes/Tabs 都已就绪。')
			return
		}

		this.syncStatus({ eventCount: existingList.length })
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

		const event: DemoEvent = {
			id: this.allocateEventId(),
			kind,
			message: trimmed,
			at: Date.now(),
		}

		this.events.insert(event)
		this.trimEventHistory()
		this.syncStatus()
		this.broadcast({ type: 'activity', message: `event:${kind}` })
		return { ...event }
	}

	increment(delta = 1) {
		const current = this.readCounter()
		const next = current + this.normalizeDelta(delta)
		this.writeCounter(next)
		this.appendEvent('counter', `计数器变更：${current} → ${next}`)
		return { counter: next }
	}

	resetCounter() {
		const current = this.readCounter()
		this.writeCounter(0)
		this.appendEvent('counter', `计数器重置：${current} → 0`)
		return { counter: 0 }
	}

	clearEvents() {
		this.events.removeMany({})
		this.appendEvent('system', '事件已清空')
		return { ok: true }
	}

	private readCounter() {
		return this.getStatusDoc()?.counter ?? 0
	}

	private writeCounter(counter: number) {
		this.syncStatus({ counter })
	}

	private normalizeDelta(delta: number) {
		const normalized = Number.isFinite(delta) ? Math.trunc(delta) : 1
		return normalized === 0 ? 1 : normalized
	}

	private getStatusDoc() {
		return this.status.findOne({ id: STATUS_DOC_ID })
	}

	private allocateEventId() {
		let nextId = this.eventSeq
		while (this.events.findOne({ id: String(nextId) })) {
			nextId += 1
		}
		this.eventSeq = nextId + 1
		return String(nextId)
	}

	private trimEventHistory() {
		const all = this.events.find({}, { sort: { at: 1 } })
		if (all.length <= MAX_EVENT_HISTORY) return
		const overflow = all.slice(0, Math.max(0, all.length - TRIMMED_EVENT_HISTORY))
		for (const old of overflow) this.events.removeOne({ id: old.id })
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

// RPC contract exposed to the custom UI.
export class PluginWithUIRpc extends RpcTarget {
	constructor(private readonly plugin: PluginWithUI) {
		super()
	}

	status() {
		return this.plugin.getStatus()
	}

	async addNote(message: string) {
		return this.plugin.appendEvent('note', message)
	}

	async increment(delta?: number) {
		return this.plugin.increment(typeof delta === 'number' ? delta : 1)
	}

	async resetCounter() {
		return this.plugin.resetCounter()
	}

	async clearEvents() {
		return this.plugin.clearEvents()
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
