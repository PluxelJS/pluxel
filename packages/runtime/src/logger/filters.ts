import type { LogFilter } from './protocol'

export function parseLogFilter(search: URLSearchParams): LogFilter {
	return {
		pluginId: search.get('pluginId') ?? undefined,
		context: search.get('context') ?? undefined,
		displayName: search.get('displayName') ?? undefined,
		category: search.get('category') ?? undefined,
	}
}

function parseSeq(raw: string | null | undefined): string | undefined {
	if (!raw) return undefined
	const s = raw.trim()
	return /^\d+$/.test(s) ? s : undefined
}

export function parseEpoch(search: URLSearchParams): number | undefined {
	const raw = search.get('epoch') ?? undefined
	if (!raw) return undefined
	const n = Number(raw)
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined
}

export function parseFromSeq(search: URLSearchParams): string | undefined {
	return (
		parseSeq(search.get('from')) ??
		parseSeq(search.get('cursor')) ??
		parseSeq(search.get('after')) ??
		undefined
	)
}

export function parseLastEventId(raw: string | undefined | null): string | undefined {
	return parseSeq(raw)
}

export function resolveFromSeq(
	search: URLSearchParams,
	lastEventId: string | undefined | null,
): string | undefined {
	const from = parseFromSeq(search)
	if (from) return from
	const last = parseLastEventId(lastEventId)
	if (!last) return undefined
	try {
		return (BigInt(last) + 1n).toString(10)
	} catch {
		return undefined
	}
}
