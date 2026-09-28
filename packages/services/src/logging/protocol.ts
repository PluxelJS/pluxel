import type { LogLevel } from '@logtape/logtape'
import { pluginNodeAddressEqual, type PluginNodeAddress } from '@pluxel/core'

export type LogFilter = {
	plugin?: PluginNodeAddress
	context?: string
	displayName?: string
	/** Category string, e.g. "pluxel.plugins" or "pluxel.runtime". Supports "prefix.*". */
	category?: string
}

export type CompiledLogFilter = {
	hasFilter: boolean
	plugin?: PluginNodeAddress
	context?: string
	displayName?: string
	categoryKey?: string
	categoryParts?: string[]
	categoryPrefix?: boolean
}

export type RuntimeLogError = {
	name?: string
	message?: string
	stack?: string
	[k: string]: unknown
}

/**
 * Canonical UI log line (transport + in-memory store + UI rendering).
 *
 * Invariants:
 * - append-only within the same `epoch`
 * - `seq` is monotonic within the same `epoch`
 * - `epoch` reset invalidates all cursors
 */
export type RuntimeLogLine = {
	streamId: string

	epoch: number
	/** uint64 string, encoded as text to remain exact beyond JS safe integers. */
	seq: string

	/** Epoch milliseconds. */
	ts: number
	level: LogLevel
	category: string[]

	/** HMR-friendly origin hints (optional). */
	name?: string
	plugin?: PluginNodeAddress
	pluginReference?: string
	pluginLabel?: string
	context?: string

	/** Fast, single-line message for the primary list. */
	msg: string
	/** Optional structured message parts (already sanitized for JSON transport). */
	message?: unknown[]
	/** Extra structured properties (already sanitized for JSON transport). */
	props?: Record<string, unknown>

	/** Extracted error-like payload (optional; still may also exist in `props`). */
	error?: RuntimeLogError
	/** Optional raw payload for detail/export (may be disabled for performance/security). */
	raw?: unknown
}

export type LogStreamMeta = {
	streamId: string
	/** Random process id to help clients detect restarts (independent from epoch). */
	bootId: string
	epoch: number
	/** Lowest retained seq (inclusive). */
	headSeq: string
	/** Highest retained seq (inclusive). `0` means empty. */
	tailSeq: string
	/** Next seq to be assigned (cursor; equals `tailSeq + 1` when non-empty). */
	nextSeq: string
	count: number
	retention: { windowLines: number }
}

export type LogRangeOk = {
	ok: true
	streamId: string
	epoch: number
	fromSeq: string
	/** Next cursor to continue scanning from. */
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

export function compileLogFilter(filter: LogFilter | undefined): CompiledLogFilter {
	if (!filter) return { hasFilter: false }
	const plugin = filter.plugin ?? undefined
	const context = filter.context ?? undefined
	const displayName = filter.displayName ?? undefined
	const rawCategory = filter.category ?? undefined
	const categoryPrefix = rawCategory ? rawCategory.endsWith('.*') : false
	const categoryKey = rawCategory
		? categoryPrefix
			? rawCategory.slice(0, -2)
			: rawCategory
		: undefined
	const categoryParts = categoryKey ? categoryKey.split('.') : undefined
	const hasFilter = !!(plugin || context || displayName || categoryKey)
	return {
		hasFilter,
		plugin,
		context,
		displayName,
		categoryKey,
		categoryParts,
		categoryPrefix,
	}
}

export function matchesLogFilterCompiled(
	record: RuntimeLogLine,
	compiled: CompiledLogFilter,
): boolean {
	if (!compiled.hasFilter) return true
	if (
		compiled.plugin &&
		(!record.plugin || !pluginNodeAddressEqual(record.plugin, compiled.plugin))
	)
		return false
	if (compiled.context && record.context !== compiled.context) return false
	if (compiled.displayName && record.name !== compiled.displayName) return false
	if (compiled.categoryKey) {
		const wantParts = compiled.categoryParts ?? []
		const got = record.category
		if (!Array.isArray(got) || got.length < wantParts.length) return false
		for (let i = 0; i < wantParts.length; i++) {
			if (got[i] !== wantParts[i]) return false
		}
		if (compiled.categoryPrefix) return true
		return got.length === wantParts.length
	}
	return true
}

export function matchesLogFilter(record: RuntimeLogLine, filter: LogFilter): boolean {
	if (filter.plugin && (!record.plugin || !pluginNodeAddressEqual(record.plugin, filter.plugin)))
		return false
	if (filter.context && record.context !== filter.context) return false
	if (filter.displayName && record.name !== filter.displayName) return false
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
