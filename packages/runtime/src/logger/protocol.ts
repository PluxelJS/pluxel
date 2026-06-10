import type { LogLevel } from '@logtape/logtape'

export type LogFilter = {
	/**
	 * Backward compatible single filter:
	 * matches `pluginId` / `context` / `name` (exact match).
	 */
	name?: string
	pluginId?: string
	context?: string
	displayName?: string
	/** Category string, e.g. "pluxel.plugins" or "pluxel.core". Supports "prefix.*". */
	category?: string
}

export type CompiledLogFilter = {
	hasFilter: boolean
	nameAny?: string
	pluginId?: string
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
	/** uint64 string (SSE-friendly, future-proof beyond JS safe integers). */
	seq: string

	/** Epoch milliseconds. */
	ts: number
	level: LogLevel
	category: string[]

	/** HMR-friendly origin hints (optional). */
	name?: string
	pluginId?: string
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

export function compileLogFilter(filter: LogFilter | undefined): CompiledLogFilter {
	if (!filter) return { hasFilter: false }
	const nameAny = filter.name ?? undefined
	const pluginId = filter.pluginId ?? undefined
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
	const hasFilter = !!(nameAny || pluginId || context || displayName || categoryKey)
	return {
		hasFilter,
		nameAny,
		pluginId,
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
	if (compiled.pluginId && record.pluginId !== compiled.pluginId) return false
	if (compiled.context && record.context !== compiled.context) return false
	if (compiled.displayName && record.name !== compiled.displayName) return false
	if (compiled.nameAny) {
		const f = compiled.nameAny
		if (record.pluginId !== f && record.context !== f && record.name !== f) return false
	}
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
