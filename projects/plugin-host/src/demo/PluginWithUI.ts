// Read this when:
// - 你要写自定义 UI
// - 你想看 Workbench Plane UI + RPC + SSE + replicated state 的最小闭环

import { BasePlugin, Plugin } from '@pluxel/runtime'
import { workbench } from '@pluxel/runtime/workbench'
import { RpcTarget } from '@pluxel/runtime/capnweb'
import { PluginWithUIWorkbench } from './PluginWithUI.workbench-extension'
import type { DemoEvent, PluginWithUIEvents, PluginWithUIStatusDoc } from './PluginWithUI.contracts'
import {
	demoDatabase,
	demoProjectionQuery,
	demoProjections,
	DemoProjectionStore,
} from './workbench-projection'

// Shared server-side data model exposed to the UI.
const STATUS_DOC_ID = 'status' as const
const MAX_EVENT_SCAN = 200
const MAX_EVENT_HISTORY = 80
const TRIMMED_EVENT_HISTORY = 50

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

@Plugin({ name: 'PluginWithUI' })
export class PluginWithUI extends BasePlugin {
	private startedAt = Date.now()

	private statusDoc?: PluginWithUIStatusDoc
	private eventDocs: DemoEvent[] = []
	private projections?: DemoProjectionStore

	private eventSeq = 1
	private eventSubscribers = new Set<
		<Key extends keyof PluginWithUIEvents>(event: Key, payload: PluginWithUIEvents[Key]) => void
	>()

	override async init() {
		this.startedAt = Date.now()

		this.initState()
		if (this.ctx.workbench.enabled) {
			const database = await this.ctx.database.use(demoDatabase)
			this.projections = new DemoProjectionStore(database)
			await this.syncProjection()
			this.ctx.workbench.mount(PluginWithUIWorkbench, {
				commands: workbench.bind.rpc(() => new PluginWithUIRpc(this)),
				status: workbench.bind.liveQuery({
					database,
					dependsOn: [demoProjections],
					query: demoProjectionQuery<PluginWithUIStatusDoc>('status'),
				}),
				events: workbench.bind.liveQuery({
					database,
					dependsOn: [demoProjections],
					query: demoProjectionQuery<DemoEvent>('events'),
				}),
				activity: workbench.bind.events<PluginWithUIEvents>((events) => this.attachEvents(events)),
			})
		}

		this.ctx.logger.info('ready')
	}

	private attachEvents(events: {
		emit<Key extends keyof PluginWithUIEvents>(event: Key, payload: PluginWithUIEvents[Key]): void
		signal: AbortSignal
	}) {
		const emit = events.emit.bind(events)
		this.eventSubscribers.add(emit)
		events.emit('ready', { type: 'ready', startedAt: this.startedAt })
		const timer = setInterval(() => events.emit('tick', { type: 'tick', now: Date.now() }), 1000)
		const cleanup = () => {
			clearInterval(timer)
			this.eventSubscribers.delete(emit)
		}
		events.signal.addEventListener('abort', cleanup, { once: true })
		return cleanup
	}

	private broadcast(payload: PluginWithUISsePayload) {
		for (const emit of this.eventSubscribers) {
			try {
				emit(payload.type, payload as never)
			} catch {}
		}
	}

	private initState() {
		const existingList = this.eventDocs.slice(0, MAX_EVENT_SCAN)
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
			eventCount: status?.eventCount ?? this.eventDocs.length,
		}
	}

	listEvents(limit = 50): DemoEvent[] {
		const capped = Math.max(0, Math.min(MAX_EVENT_SCAN, Math.floor(limit)))
		const docs = this.eventDocs.toSorted((left, right) => right.at - left.at).slice(0, capped)
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

		this.eventDocs.push(event)
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
		this.eventDocs = []
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
		return this.statusDoc ? { ...this.statusDoc } : undefined
	}

	private allocateEventId() {
		let nextId = this.eventSeq
		while (this.eventDocs.some((event) => event.id === String(nextId))) {
			nextId += 1
		}
		this.eventSeq = nextId + 1
		return String(nextId)
	}

	private trimEventHistory() {
		const all = this.eventDocs.toSorted((left, right) => left.at - right.at)
		if (all.length <= MAX_EVENT_HISTORY) return
		const overflow = all.slice(0, Math.max(0, all.length - TRIMMED_EVENT_HISTORY))
		const removed = new Set(overflow.map(({ id }) => id))
		this.eventDocs = this.eventDocs.filter(({ id }) => !removed.has(id))
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
			eventCount: input.eventCount ?? this.eventDocs.length,
		}
	}

	private syncStatus(override: Partial<Omit<PluginWithUIStatusDoc, 'id'>> = {}) {
		const next = this.buildStatusDoc({
			counter: override.counter,
			eventCount: override.eventCount,
		})
		this.statusDoc = next
		void this.syncProjection()
	}

	private async syncProjection(): Promise<void> {
		if (!this.projections) return
		await Promise.all([
			this.projections.replaceAll('status', this.statusDoc ? [this.statusDoc] : []),
			this.projections.replaceAll('events', this.eventDocs),
		])
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
