import EventEmitter from 'node:events'

export type UiLogRecord = {
	/** Monotonic id (process-local). Used for cursors/dedup. */
	id: number
	/** Epoch milliseconds. */
	time: number
	level: string
	category: string[]
	msg: string
	name?: string
	pluginId?: string
	context?: string
	/** Extra structured properties (already sanitized for JSON transport). */
	props?: Record<string, unknown>
}

export type LogListener = (record: UiLogRecord) => void

export type LogFilter = {
	/**
	 * Backward compatible single filter:
	 * matches `pluginId` / `context` / `name` (exact match).
	 */
	name?: string
	pluginId?: string
	context?: string
	displayName?: string
	/** Category string, e.g. "pluxel.hmr" or "pluxel.plugins". Supports "prefix.*". */
	category?: string
}

export const matchesFilter = (record: UiLogRecord, filter: LogFilter): boolean => {
	if (filter.pluginId && record.pluginId !== filter.pluginId) return false
	if (filter.context && record.context !== filter.context) return false
	if (filter.displayName && record.name !== filter.displayName) return false
	if (filter.name) {
		const f = filter.name
		if (record.pluginId !== f && record.context !== f && record.name !== f) return false
	}
	if (filter.category) {
		const joined = record.category.join('.')
		const raw = filter.category
		const want = raw.endsWith('.*') ? raw.slice(0, -2) : raw
		if (raw.endsWith('.*')) {
			if (joined !== want && !joined.startsWith(`${want}.`)) return false
		} else {
			if (joined !== want) return false
		}
	}
	return true
}

const LOG_EVENT = 'new_log'

const randomBootId = (): string => {
	const c = (globalThis as any).crypto as undefined | { randomUUID?: () => string }
	if (c?.randomUUID) return c.randomUUID()
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

export class LogStore {
	private readonly buffer: Array<UiLogRecord | undefined>
	private pointer = 0
	private count = 0
	private seq = 0
	public readonly bootId = randomBootId()
	public readonly events = new EventEmitter()

	constructor(private readonly size = 500) {
		this.buffer = new Array(size)
		this.events.setMaxListeners(1000)
	}

	push(record: Omit<UiLogRecord, 'id'>): UiLogRecord {
		const next: UiLogRecord = { id: ++this.seq, ...record }
		this.buffer[this.pointer] = next
		this.pointer = (this.pointer + 1) % this.size
		if (this.count < this.size) this.count++
		this.events.emit(LOG_EVENT, next)
		return next
	}

	snapshot(limit = this.size, afterId?: number): UiLogRecord[] {
		const result: UiLogRecord[] = []
		const target = Math.min(limit, this.count)
		const start = (this.pointer - target + this.size) % this.size
		for (let i = 0; i < target; i++) {
			const idx = (start + i) % this.size
			const rec = this.buffer[idx]
			if (!rec) continue
			if (afterId !== undefined && rec.id <= afterId) continue
			result.push(rec)
		}
		return result
	}

	subscribe(listener: LogListener): () => void {
		this.events.on(LOG_EVENT, listener)
		return () => {
			this.events.off(LOG_EVENT, listener)
		}
	}

	get capacity() {
		return this.size
	}

	get lastId() {
		return this.seq
	}
}

// UI log buffer: keep enough history for the in-browser log viewer.
export const logStore = new LogStore(2000)
export { LOG_EVENT }
