export const PLUXEL_PLUGIN_FORK_SEPARATOR = '#' as const

// Plugin ids are used as:
// - persisted config keys
// - UI identifiers
// - log attribution
//
// So we keep them strict, ASCII, and parseable.
//
// Supported forms:
// - base plugin id: "Pkg/Plugin" (segments separated by "/")
// - fork id:       "Pkg/Plugin#forkId"
//
// Notes:
// - base plugin ids may include scoped package segments ("@scope/pkg/Plugin").
// - fork ids are reserved for runtime forks (ForkablePlugin); forkId must not contain separators.

const BASE_SEGMENT_RE = /^[A-Za-z0-9@][A-Za-z0-9@._-]*$/
const FORK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export function isValidBasePluginId(id: string): boolean {
	if (typeof id !== 'string') return false
	const text = id.trim()
	if (!text) return false
	if (text.includes(PLUXEL_PLUGIN_FORK_SEPARATOR)) return false
	if (text.includes('\\') || text.includes('\0')) return false
	if (/\s/.test(text)) return false

	const parts = text.split('/')
	for (let i = 0; i < parts.length; i++) {
		const seg = parts[i]!
		if (!seg) return false
		if (!BASE_SEGMENT_RE.test(seg)) return false
	}
	return true
}

export function assertValidBasePluginId(id: string): void {
	if (!isValidBasePluginId(id)) {
		throw new Error(
			`Invalid base plugin id "${String(id)}". ` +
				`Expected ASCII segments like "Pkg/Plugin" without whitespace or "${PLUXEL_PLUGIN_FORK_SEPARATOR}".`,
		)
	}
}

export function isValidForkId(forkId: string): boolean {
	if (typeof forkId !== 'string') return false
	const text = forkId.trim()
	if (!text) return false
	if (text.includes('/') || text.includes('\\') || text.includes('\0')) return false
	if (text.includes(PLUXEL_PLUGIN_FORK_SEPARATOR)) return false
	if (/\s/.test(text)) return false
	return FORK_ID_RE.test(text)
}

export function assertValidForkId(forkId: string): void {
	if (!isValidForkId(forkId)) {
		throw new Error(
			`Invalid fork id "${String(forkId)}". ` +
				`Expected ASCII like "dev" / "a1" / "foo-bar" without whitespace or separators.`,
		)
	}
}

export function formatForkPluginId(baseId: string, forkId: string): string {
	assertValidBasePluginId(baseId)
	assertValidForkId(forkId)
	return `${baseId}${PLUXEL_PLUGIN_FORK_SEPARATOR}${forkId}`
}

export function parseForkPluginId(
	id: string,
): { baseId: string; forkId: string } | null {
	if (typeof id !== 'string') return null
	const text = id.trim()
	const idx = text.indexOf(PLUXEL_PLUGIN_FORK_SEPARATOR)
	if (idx <= 0) return null
	if (idx !== text.lastIndexOf(PLUXEL_PLUGIN_FORK_SEPARATOR)) return null
	const baseId = text.slice(0, idx)
	const forkId = text.slice(idx + 1)
	if (!isValidBasePluginId(baseId)) return null
	if (!isValidForkId(forkId)) return null
	return { baseId, forkId }
}

export function isForkPluginId(id: string): boolean {
	return parseForkPluginId(id) !== null
}

export function assertValidPluginId(id: string): void {
	const text = String(id ?? '').trim()
	if (!text) throw new Error('Invalid plugin id: empty')
	if (parseForkPluginId(text)) return
	assertValidBasePluginId(text)
}

