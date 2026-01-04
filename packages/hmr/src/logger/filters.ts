import type { LogFilter } from './logStore'

export function parseLogFilter(search: URLSearchParams): LogFilter {
	return {
		// Back-compat: `name` is an "any-of" filter.
		name: search.get('name') ?? undefined,
		pluginId: search.get('pluginId') ?? undefined,
		context: search.get('context') ?? undefined,
		displayName: search.get('displayName') ?? undefined,
		category: search.get('category') ?? undefined,
	}
}

export function parseAfterId(search: URLSearchParams): number | undefined {
	const raw = search.get('after') ?? search.get('afterId') ?? undefined
	if (!raw) return undefined
	const n = Number(raw)
	return Number.isFinite(n) && n > 0 ? n : undefined
}

export function parseLastEventId(raw: string | undefined | null): number | undefined {
	if (!raw) return undefined
	const n = Number(raw)
	return Number.isFinite(n) && n > 0 ? n : undefined
}

export function resolveAfterId(
	search: URLSearchParams,
	lastEventId: string | undefined | null,
): number | undefined {
	return parseAfterId(search) ?? parseLastEventId(lastEventId)
}

