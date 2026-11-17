/** Select declared and managed inputs without changing either layer. */
export type HostInputMode = 'declared-only' | 'declared-first' | 'saved-first'

export function parseHostInputMode(value: unknown, label = 'mode'): HostInputMode {
	if (value === undefined) return 'declared-first'
	if (value === 'declared-only' || value === 'declared-first' || value === 'saved-first')
		return value
	throw new TypeError(`[host] ${label} must be declared-only, declared-first or saved-first`)
}

export function selectHostInput<T>(
	mode: HostInputMode,
	declared: T | undefined,
	saved: T | undefined,
	fallback: T,
): T {
	if (mode === 'declared-only') return declared === undefined ? fallback : declared
	const first = mode === 'saved-first' ? saved : declared
	const second = mode === 'saved-first' ? declared : saved
	return first === undefined ? (second === undefined ? fallback : second) : first
}
