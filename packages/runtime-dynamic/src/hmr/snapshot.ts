/**
 * Minimal workspace snapshot that the HMR host needs to boot deterministically.
 *
 * This intentionally does NOT depend on `@pluxel/cli` so `@pluxel/runtime` core stays decoupled.
 *
 * Notes:
 * - All paths are expected to be root-relative (preferred) or absolute. The host normalizes to abs.
 * - Callers may include extra fields; the host ignores unknown keys.
 */
export type LoaderHmrWorkspaceSnapshot = {
	activeProfile: string
	roots: string[]
	enabled: string[]
	enabledEntries: string[]
	includedEntries: string[]
	watchRoots: string[]
	includeGlobs: string[]
	excludeGlobs: string[]
}

function assertStringArray(value: unknown, label: string): asserts value is string[] {
	if (!Array.isArray(value)) throw new Error(`[loader-hmr] Invalid snapshot: ${label} missing.`)
	if (value.some((x) => typeof x !== 'string')) {
		throw new Error(`[loader-hmr] Invalid snapshot: ${label} must be string[].`)
	}
}

export function assertLoaderHmrWorkspace(
	snapshot: unknown,
): asserts snapshot is LoaderHmrWorkspaceSnapshot {
	if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
		throw new Error('[loader-hmr] Invalid snapshot: expected object.')
	}
	const s = snapshot as Record<string, unknown>
	if (typeof s.activeProfile !== 'string' || !s.activeProfile.trim()) {
		throw new Error('[loader-hmr] Invalid snapshot: activeProfile missing.')
	}

	assertStringArray(s.roots, 'roots')
	assertStringArray(s.enabled, 'enabled')
	assertStringArray(s.enabledEntries, 'enabledEntries')
	assertStringArray(s.includedEntries, 'includedEntries')
	assertStringArray(s.watchRoots, 'watchRoots')
	assertStringArray(s.includeGlobs, 'includeGlobs')
	assertStringArray(s.excludeGlobs, 'excludeGlobs')
}
