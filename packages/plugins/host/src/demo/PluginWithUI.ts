// 展示型插件：自定义 UI 扩展 + RPC + SSE（带持久化 state）。
//
// 这是“完整链路”的参考实现：UI -> RPC -> 插件状态 -> SSE 实时推送。

import { BasePlugin, Plugin } from '@pluxel/hmr'
import { RpcTarget } from '@pluxel/hmr/capnweb'
import type { SseChannel } from '@pluxel/hmr/services'
import { Collection } from '@pluxel/hmr/signaldb'

type CounterDoc = { id: 'counter'; value: number; updatedAt: number }
type EventSeqDoc = { id: 'event-seq'; value: number }

export type DemoEvent = {
	id: string
	kind: 'system' | 'note' | 'counter'
	message: string
	at: number
}

export type PluginWithUIStatus = {
	pluginName: string
	startedAt: number
	uptimeMs: number
	counter: number
	eventCount: number
}

export type PluginWithUISsePayload =
	| { type: 'ready'; status: PluginWithUIStatus }
	| { type: 'tick'; now: number }
	| { type: 'snapshot'; status: PluginWithUIStatus; events: DemoEvent[] }
	| { type: 'event'; event: DemoEvent; status: PluginWithUIStatus }
	| { type: 'cleared' }

@Plugin({ name: 'PluginWithUI' })
export class PluginWithUI extends BasePlugin {
	private startedAt = Date.now()

	private counter!: Collection<CounterDoc>
	private events!: Collection<DemoEvent>
	private meta!: Collection<EventSeqDoc>

	private eventSeq = 1
	private channels = new Set<SseChannel>()

	override async init() {
		this.startedAt = Date.now()

		await this.initState()

		this.ctx.ext.ui.register({ entryPath: './PluginWithUI/ui/index.tsx' })
		this.ctx.ext.rpc.registerExtension(() => new PluginWithUIRpc(this))
		this.ctx.ext.sse.registerExtension(() => this.attachSse())

		this.ctx.logger.info('ready')
	}

	private attachSse() {
		return (channel: SseChannel) => {
			this.channels.add(channel)

			channel.emit('ready', { type: 'ready', status: this.getStatus() })
			channel.emit('snapshot', { type: 'snapshot', ...this.getSnapshotPayload() })

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
		this.counter = new Collection<CounterDoc, string, CounterDoc>({
			name: 'counter',
			persistence: await this.ctx.pluginData.persistenceForCollection<CounterDoc>('counter'),
		})
		this.events = new Collection<DemoEvent, string, DemoEvent>({
			name: 'events',
			persistence: await this.ctx.pluginData.persistenceForCollection<DemoEvent>('events'),
		})
		this.meta = new Collection<EventSeqDoc, string, EventSeqDoc>({
			name: 'meta',
			persistence: await this.ctx.pluginData.persistenceForCollection<EventSeqDoc>('meta'),
		})

		const existingCounter = this.counter.findOne({ id: 'counter' })
		if (!existingCounter) {
			this.counter.insert({ id: 'counter', value: 0, updatedAt: Date.now() })
		}

		const existingEvents = this.events.find()
		const existingList = existingEvents.fetch().map((e) => ({ ...e, id: String(e.id) }))
		const maxId = existingList.reduce((acc, e) => Math.max(acc, Number(e.id) || 0), 0)

		const seqDoc = this.meta.findOne({ id: 'event-seq' })
		const persisted = typeof seqDoc?.value === 'number' ? seqDoc.value : 0
		const last = Math.max(maxId, persisted, 0)
		this.eventSeq = last + 1
		if (!seqDoc) this.meta.insert({ id: 'event-seq', value: last })
		else if (seqDoc.value !== last)
			this.meta.updateOne({ id: 'event-seq' }, { $set: { value: last } })

		if (existingEvents.count() === 0)
			this.appendEvent('system', 'UI 扩展已加载：RPC/SSE/Routes/Tabs 都已就绪。')
	}

	getStatus() {
		const counter = this.counter.findOne({ id: 'counter' })?.value ?? 0
		return {
			pluginName: this.ctx.pluginInfo.id,
			startedAt: this.startedAt,
			uptimeMs: Date.now() - this.startedAt,
			counter,
			eventCount: this.events.find().count(),
		}
	}

	private getSnapshotPayload() {
		const events = this.events
			.find({}, { limit: 50 })
			.fetch()
			.map((e) => ({ ...e, id: String(e.id) }))
			.sort((a, b) => b.at - a.at)
		return { status: this.getStatus(), events }
	}

	listEvents(limit = 50): DemoEvent[] {
		const capped = Math.max(0, Math.min(200, Math.floor(limit)))
		const docs = this.events.find().fetch()
		return docs
			.map((e) => ({ ...e, id: String(e.id ?? '') }))
			.sort((a, b) => b.at - a.at)
			.slice(0, capped)
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
		this.meta.updateOne({ id: 'event-seq' }, { $set: { value: Number(event.id) || 0 } })

		const all = this.events.find()
		if (all.count() > 80) {
			const sorted = all
				.fetch()
				.sort((a, b) => a.at - b.at)
				.slice(0, Math.max(0, all.count() - 50))
			for (const old of sorted) {
				this.events.removeOne({ id: old.id })
			}
		}

		this.broadcast({ type: 'event', event, status: this.getStatus() })
		return { ...event }
	}

	increment(delta = 1) {
		const n = Number.isFinite(delta) ? Math.trunc(delta) : 1
		const doc = this.counter.findOne({ id: 'counter' })
		const next = (doc?.value ?? 0) + (n === 0 ? 1 : n)
		this.counter.updateOne({ id: 'counter' }, { $set: { value: next, updatedAt: Date.now() } })
		this.appendEvent('counter', `计数器变更：${doc?.value ?? 0} → ${next}`)
		return { counter: next }
	}

	resetCounter() {
		const doc = this.counter.findOne({ id: 'counter' })
		this.counter.updateOne({ id: 'counter' }, { $set: { value: 0, updatedAt: Date.now() } })
		this.appendEvent('counter', `计数器重置：${doc?.value ?? 0} → 0`)
		return { counter: 0 }
	}

	clearEvents() {
		this.events.removeMany({})
		this.broadcast({ type: 'cleared' })
		this.appendEvent('system', '事件已清空')
		return { ok: true }
	}
}

export class PluginWithUIRpc extends RpcTarget {
	constructor(private readonly plugin: PluginWithUI) {
		super()
	}

	status() {
		return this.plugin.getStatus()
	}

	events(limit?: number) {
		return Promise.resolve(this.plugin.listEvents(limit ?? 50))
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

declare module '@pluxel/hmr/web' {
	namespace UI {
		interface rpc {
			PluginWithUI: PluginWithUIRpc
		}

		interface sse {
			PluginWithUI: PluginWithUISsePayload
		}
	}
}
