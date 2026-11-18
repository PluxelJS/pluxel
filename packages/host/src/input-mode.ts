/** Select declared and managed inputs without changing either layer. */
export type HostInputMode = 'declared-only' | 'declared-first' | 'saved-first'

export function parseHostInputMode(value: unknown, label = 'mode'): HostInputMode {
	if (value === undefined) return 'declared-first'
	if (value === 'declared-only' || value === 'declared-first' || value === 'saved-first')
		return value
	throw new TypeError(`[host] ${label} must be declared-only, declared-first or saved-first`)
}

export type HostInputSource = 'declared' | 'saved' | 'default'

export function hostInputSource(
	mode: HostInputMode,
	declared: unknown,
	saved: unknown,
): HostInputSource {
	if (mode === 'saved-first' && saved !== undefined) return 'saved'
	if (declared !== undefined) return 'declared'
	return mode !== 'declared-only' && saved !== undefined ? 'saved' : 'default'
}
