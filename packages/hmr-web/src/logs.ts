import type { LogLevel } from './protocol-types'

export interface LogFilter {
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

export type RuntimeLogError = {
	name?: string
	message?: string
	stack?: string
	[k: string]: unknown
}

export interface RuntimeLogLine {
	streamId: string
	epoch: number
	/** uint64 string */
	seq: string
	ts: number
	level: LogLevel
	category: string[]
	name?: string
	pluginId?: string
	context?: string
	msg: string
	message?: unknown[]
	props?: Record<string, unknown>
	error?: RuntimeLogError
	raw?: unknown
}

export type LogStreamMeta = {
	streamId: string
	bootId: string
	epoch: number
	headSeq: string
	tailSeq: string
	nextSeq: string
	count: number
	retention: { windowLines: number }
}

export type LogRangeOk = {
	ok: true
	streamId: string
	epoch: number
	fromSeq: string
	nextSeq: string
	lines: RuntimeLogLine[]
}

export type LogRangeErr = {
	ok: false
	code: 'epoch_mismatch' | 'from_too_old' | 'invalid'
	message?: string
	streamId?: string
	epoch?: number
	headSeq?: string
	tailSeq?: string
}

export type LogRangeResult = LogRangeOk | LogRangeErr

export type LogSseAppend = {
	type: 'append'
	streamId: string
	epoch: number
	fromSeq: string
	nextSeq: string
	lines: RuntimeLogLine[]
}

export type LogSseGap = {
	type: 'gap'
	streamId: string
	epoch: number
	missingFrom: string
	missingTo: string
}

export type LogSseReset = {
	type: 'reset'
	streamId: string
	bootId: string
	epoch: number
	headSeq: string
	tailSeq: string
	nextSeq: string
	count: number
	retention: { windowLines: number }
}

export type LogSseEvent = LogSseAppend | LogSseGap | LogSseReset
