// 展示型插件：自定义 UI 扩展 + 路由 + standalone frame + RPC + SSE（带持久化 state）。
//
// 这是“完整链路”的参考实现：ui().bind(ctx) -> definePluginUIModule() -> routes/extensions -> RPC/SSE。
// 其中 ui().bind(ctx) 是给 HMR/AST 识别的桥接声明：dev 下由 HMR 消费源码声明，非 HMR 下回落到 packaged remote 注册。

import { BasePlugin, Plugin } from '@pluxel/runtime'
import { ui } from '@pluxel/hmr/plugin'
import { RpcTarget } from '@pluxel/runtime/capnweb'
import type { SseChannel } from '@pluxel/runtime/services'

type PluginWithUIStatusDoc = PluginWithUIStatus & { id: 'status' }

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

const pluginUi = ui('./PluginWithUI/ui/index.tsx')

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

		const existingList = this.events
			.find({}, { limit: 200 })
			.map((event: DemoEvent) => ({ ...event, id: String(event.id) }))
		const maxId = existingList.reduce((acc, e) => Math.max(acc, Number(e.id) || 0), 0)
		this.eventSeq = Math.max(maxId, 0) + 1

		const statusDoc = this.status.findOne({ id: 'status' })
		this.writeStatus({
			current: statusDoc,
			counter: statusDoc?.counter ?? 0,
			eventCount: existingList.length,
		})

		if (existingList.length === 0)
			this.appendEvent('system', 'UI 扩展已加载：RPC/SSE/Routes/Tabs 都已就绪。')
		else this.syncStatus()
	}

	getStatus() {
		const status = this.status.findOne({ id: 'status' })
		return status
			? {
					pluginName: status.pluginName,
					startedAt: status.startedAt,
					counter: status.counter,
					eventCount: status.eventCount,
				}
			: {
					pluginName: this.ctx.pluginInfo.id,
					startedAt: this.startedAt,
					counter: 0,
					eventCount: this.events.count(),
				}
	}

	listEvents(limit = 50): DemoEvent[] {
		const capped = Math.max(0, Math.min(200, Math.floor(limit)))
		const docs = this.events.find({}, { limit: capped, sort: { at: -1 } })
		return docs
			.map((event: DemoEvent) => ({ ...event, id: String(event.id ?? '') }))
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

		const all = this.events.find({}, { sort: { at: 1 } })
		if (all.length > 80) {
			const sorted = all.slice(0, Math.max(0, all.length - 50))
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
		const status = this.status.findOne({ id: 'status' })
		const current = status?.counter ?? 0
		const next = current + (n === 0 ? 1 : n)
		this.syncStatus({ counter: next })
		this.appendEvent('counter', `计数器变更：${current} → ${next}`)
		return { counter: next }
	}

	resetCounter() {
		const status = this.status.findOne({ id: 'status' })
		this.syncStatus({ counter: 0 })
		this.appendEvent('counter', `计数器重置：${status?.counter ?? 0} → 0`)
		return { counter: 0 }
	}

	clearEvents() {
		this.events.removeMany({})
		this.syncStatus()
		this.broadcast({ type: 'activity', message: 'events:cleared' })
		this.appendEvent('system', '事件已清空')
		return { ok: true }
	}

	private buildStatusDoc(input: {
		current?: PluginWithUIStatusDoc
		counter?: number
		eventCount?: number
	} = {}): PluginWithUIStatusDoc {
		return {
			id: 'status',
			pluginName: this.ctx.pluginInfo.id,
			startedAt: this.startedAt,
			counter: input.counter ?? input.current?.counter ?? 0,
			eventCount: input.eventCount ?? this.events.count(),
		}
	}

	private syncStatus(override: Partial<Omit<PluginWithUIStatusDoc, 'id'>> = {}) {
		this.writeStatus({
			current: this.status.findOne({ id: 'status' }),
			counter: override.counter,
			eventCount: override.eventCount,
		})
	}

	private writeStatus(input: {
		current?: PluginWithUIStatusDoc
		counter?: number
		eventCount?: number
	}) {
		const next = this.buildStatusDoc({
			current: input.current,
			counter: input.counter,
			eventCount: input.eventCount,
		})
		if (input.current) this.status.replaceOne({ id: 'status' }, next, { upsert: true })
		else this.status.insert(next)
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
	interface HmrUiRpcMap {
		PluginWithUI: PluginWithUIRpc
	}

	interface HmrUiSseMap {
		PluginWithUI: PluginWithUISsePayload
	}

	interface HmrUiSignalDbMap {
		PluginWithUI: {
			status: PluginWithUIStatusDoc
			events: DemoEvent
		}
	}
}
