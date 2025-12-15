import EventEmitter from 'node:events'

export interface LogRecord {
	time: string
	level: number | string
	name?: string      // 显示名称（scope/module）
	pluginId?: string  // 插件标识，用于过滤
	msg: string
	[key: string]: any
}

export type LogListener = (record: LogRecord) => void

/** 日志过滤：按 pluginId 或 name 匹配 */
export const matchesFilter = (record: LogRecord, filter: string): boolean =>
	!filter || record.pluginId === filter || record.name === filter

const LOG_EVENT = 'new_log'

export class LogStore {
	private readonly buffer: Array<LogRecord | undefined>
	private pointer = 0
	public readonly events = new EventEmitter()

	constructor(private readonly size = 500) {
		this.buffer = new Array(size)
		this.events.setMaxListeners(1000)
	}

	push(record: LogRecord) {
		this.buffer[this.pointer] = record
		this.pointer = (this.pointer + 1) % this.size
		this.events.emit(LOG_EVENT, record)
	}

	snapshot(limit = this.size): LogRecord[] {
		const result: LogRecord[] = []
		const count = Math.min(limit, this.size)
		for (let i = 0; i < count; i++) {
			const idx = (this.pointer + i) % this.size
			const rec = this.buffer[idx]
			if (rec) result.push(rec)
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
}

export const logStore = new LogStore()
export { LOG_EVENT }
