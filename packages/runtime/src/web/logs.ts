import type { LogLevel } from './protocol'
import type { PluginNodeAddress } from '@pluxel/core'

export interface LogFilter {
	plugin?: PluginNodeAddress
	context?: string
	displayName?: string
	/** Category string, e.g. "pluxel.plugins" or "pluxel.core". Supports "prefix.*". */
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
	plugin?: PluginNodeAddress
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

export type RuntimeLogAppend = {
	type: 'append'
	streamId: string
	epoch: number
	fromSeq: string
	nextSeq: string
	lines: readonly RuntimeLogLine[]
}

export type RuntimeLogGap = {
	type: 'gap'
	streamId: string
	epoch: number
	missingFrom: string
	missingTo: string
}

export type RuntimeLogReset = {
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

export type RuntimeLogEvent = RuntimeLogAppend | RuntimeLogGap | RuntimeLogReset
