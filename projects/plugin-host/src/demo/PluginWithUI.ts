// Direct Workbench demo: one definition, fresh Cap'n Web roots, Plugin-owned watch semantics.

import { BasePlugin, Plugin } from '@pluxel/runtime'
import { RpcTarget, type RpcStub } from '@pluxel/runtime/capnweb'
import {
	PluginWithUIWorkbench,
	type DemoEvent,
	type PluginWithUIApi,
	type PluginWithUIObserver,
	type PluginWithUISnapshot,
} from './PluginWithUI.workbench'

const MAX_EVENT_HISTORY = 80
const MAX_EVENT_MESSAGE_LENGTH = 1_000
const MAX_COUNTER_DELTA = 1_000

@Plugin()
export class PluginWithUI extends BasePlugin {
	private readonly startedAt = Date.now()
	private readonly listeners = new Set<(revision: number) => void>()
	private events: DemoEvent[] = []
	private counter = 0
	private revision = 1
	private eventSeq = 1

	override init(): void {
		this.appendEvent('system', 'Direct Cap’n Web Workbench View 已就绪。')
		this.ctx.workbench?.publish(PluginWithUIWorkbench, {
			overview: ({ signal }) => new PluginWithUITarget(this, signal),
			events: ({ signal }) => new PluginWithUITarget(this, signal),
			dashboard: ({ signal }) => new PluginWithUITarget(this, signal),
		})
	}

	snapshot(): PluginWithUISnapshot {
		return Object.freeze({
			revision: this.revision,
			pluginName: this.ctx.pluginInfo.displayName,
			startedAt: this.startedAt,
			counter: this.counter,
			events: Object.freeze(this.events.map((event) => Object.freeze({ ...event }))),
		})
	}

	subscribe(listener: (revision: number) => void): Disposable {
		this.listeners.add(listener)
		let active = true
		return Object.freeze({
			[Symbol.dispose]: () => {
				if (!active) return
				active = false
				this.listeners.delete(listener)
			},
		})
	}

	addNote(message: string): DemoEvent {
		return this.appendEvent('note', message)
	}

	increment(delta = 1): Readonly<{ counter: number }> {
		if (!Number.isSafeInteger(delta) || Math.abs(delta) > MAX_COUNTER_DELTA) {
			throw new RangeError(`计数器增量必须是 -${MAX_COUNTER_DELTA} 到 ${MAX_COUNTER_DELTA} 的整数`)
		}
		const normalized = delta
		const previous = this.counter
		const next = this.counter + normalized
		if (!Number.isSafeInteger(next)) throw new RangeError('计数器超出安全整数范围')
		this.counter = next
		this.appendEvent('counter', `计数器变更：${previous} → ${this.counter}`)
		return Object.freeze({ counter: this.counter })
	}

	resetCounter(): Readonly<{ counter: number }> {
		const previous = this.counter
		this.counter = 0
		this.appendEvent('counter', `计数器重置：${previous} → 0`)
		return Object.freeze({ counter: 0 })
	}

	clearEvents(): Readonly<{ ok: true }> {
		this.events = []
		this.appendEvent('system', '事件已清空')
		return Object.freeze({ ok: true })
	}

	private appendEvent(kind: DemoEvent['kind'], input: string): DemoEvent {
		const message = input.trim()
		if (!message) throw new TypeError('消息不能为空')
		if (message.length > MAX_EVENT_MESSAGE_LENGTH) {
			throw new RangeError(`消息不能超过 ${MAX_EVENT_MESSAGE_LENGTH} 个 UTF-16 code units`)
		}
		const event = Object.freeze({
			id: String(this.eventSeq++),
			kind,
			message,
			at: Date.now(),
		})
		this.events = [...this.events, event].slice(-MAX_EVENT_HISTORY)
		this.revision += 1
		const listeners = [...this.listeners]
		for (const listener of listeners) listener(this.revision)
		return event
	}
}

class PluginWithUITarget extends RpcTarget implements PluginWithUIApi {
	constructor(
		private readonly plugin: PluginWithUI,
		private readonly signal: AbortSignal,
	) {
		super()
	}

	snapshot() {
		return this.plugin.snapshot()
	}

	watch(observer: PluginWithUIObserver): RpcTarget {
		return new PluginWithUISubscription(
			this.plugin,
			observer as RpcStub<PluginWithUIObserver>,
			this.signal,
		)
	}

	addNote(message: string) {
		return this.plugin.addNote(message)
	}

	increment(delta?: number) {
		return this.plugin.increment(delta)
	}

	resetCounter() {
		return this.plugin.resetCounter()
	}

	clearEvents() {
		return this.plugin.clearEvents()
	}
}

class PluginWithUISubscription extends RpcTarget {
	readonly #observer: RpcStub<PluginWithUIObserver>
	readonly #subscription: Disposable
	readonly #onAbort: () => void
	readonly #signal: AbortSignal
	#active = true

	constructor(plugin: PluginWithUI, observer: RpcStub<PluginWithUIObserver>, signal: AbortSignal) {
		super()
		if (!observer || typeof observer !== 'function' || typeof observer.dup !== 'function') {
			throw new TypeError('watch observer must be a Cap’n Web callback')
		}
		this.#observer = observer.dup()
		this.#signal = signal
		this.#onAbort = () => this[Symbol.dispose]()
		this.#subscription = plugin.subscribe((revision) => {
			try {
				const result = this.#observer(revision)
				void (async () => {
					try {
						await result
					} catch {
						this[Symbol.dispose]()
					} finally {
						result[Symbol.dispose]()
					}
				})()
			} catch {
				this[Symbol.dispose]()
			}
		})
		if (signal.aborted) this[Symbol.dispose]()
		else signal.addEventListener('abort', this.#onAbort, { once: true })
	}

	[Symbol.dispose](): void {
		if (!this.#active) return
		this.#active = false
		this.#signal.removeEventListener('abort', this.#onAbort)
		this.#subscription[Symbol.dispose]()
		this.#observer[Symbol.dispose]()
	}
}
