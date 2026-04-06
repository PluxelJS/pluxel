export type BuiltinsFromDistEntry = {
	packageName: string
	entry: string
	/**
	 * Optional export key used by the runtime loader.
	 *
	 * When omitted, the loader uses its default export selection behavior.
	 */
	exportKey?: string
	/**
	 * Optional runtime enable flag for this builtin entry.
	 *
	 * When omitted, the loader uses its default enable behavior.
	 */
	enable?: boolean
}

/**
 * Minimal workspace snapshot that the HMR host needs to boot deterministically.
 *
 * This intentionally does NOT depend on `@pluxel/cli` so `@pluxel/runtime` core stays decoupled.
 *
 * Notes:
 * - All paths are expected to be root-relative (preferred) or absolute. The host normalizes to abs.
 * - Callers may include extra fields; the host ignores unknown keys.
 */
export type HmrWorkspaceSnapshot = {
	activeProfile: string
	roots: string[]
	enabled: string[]
	builtinPackages: string[]
	builtinsFromDist?: ReadonlyArray<BuiltinsFromDistEntry>
	enabledEntries: string[]
	includedEntries: string[]
	watchRoots: string[]
	includeGlobs: string[]
	excludeGlobs: string[]
}

function assertStringArray(value: unknown, label: string): asserts value is string[] {
	if (!Array.isArray(value)) throw new Error(`[hmr] Invalid snapshot: ${label} missing.`)
	if (value.some((x) => typeof x !== 'string')) {
		throw new Error(`[hmr] Invalid snapshot: ${label} must be string[].`)
	}
}

export function assertHmrWorkspaceSnapshot(
	snapshot: unknown,
): asserts snapshot is HmrWorkspaceSnapshot {
	if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
		throw new Error('[hmr] Invalid snapshot: expected object.')
	}
	const s = snapshot as Record<string, unknown>
	if (typeof s.activeProfile !== 'string' || !s.activeProfile.trim()) {
		throw new Error('[hmr] Invalid snapshot: activeProfile missing.')
	}

	assertStringArray(s.roots, 'roots')
	assertStringArray(s.enabled, 'enabled')
	assertStringArray(s.builtinPackages, 'builtinPackages')
	assertStringArray(s.enabledEntries, 'enabledEntries')
	assertStringArray(s.includedEntries, 'includedEntries')
	assertStringArray(s.watchRoots, 'watchRoots')
	assertStringArray(s.includeGlobs, 'includeGlobs')
	assertStringArray(s.excludeGlobs, 'excludeGlobs')

	if (s.builtinsFromDist !== undefined) {
		if (!Array.isArray(s.builtinsFromDist)) {
			throw new TypeError('[hmr] Invalid snapshot: builtinsFromDist must be an array.')
		}
		for (const raw of s.builtinsFromDist) {
			if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
				throw new TypeError('[hmr] Invalid snapshot: builtinsFromDist must contain objects.')
			}
			const o = raw as Record<string, unknown>
			if (typeof o.packageName !== 'string' || !o.packageName.trim()) {
				throw new Error('[hmr] Invalid snapshot: builtinsFromDist[].packageName must be a string.')
			}
			if (typeof o.entry !== 'string' || !o.entry.trim()) {
				throw new Error('[hmr] Invalid snapshot: builtinsFromDist[].entry must be a string.')
			}
		}
	}
}
