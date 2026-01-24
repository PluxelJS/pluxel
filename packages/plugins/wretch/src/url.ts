export function normalizeBaseUrl(baseUrl: unknown): string | undefined {
	if (typeof baseUrl !== 'string') return undefined
	const trimmed = baseUrl.trim()
	if (!trimmed) return undefined
	try {
		const u = new URL(trimmed)
		const out = u.toString()
		// wretch joins base + "/path" by concatenation-like logic; a trailing "/"
		// on base plus a leading "/" on path can produce "//".
		return out.endsWith('/') ? out.slice(0, -1) : out
	} catch {
		// Best-effort: accept as-is and let URL resolution fall back to string join.
		return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed
	}
}
