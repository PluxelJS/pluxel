export const DRIVE_PATH_RE = /^[a-zA-Z]:[\\/]/ as const

export function cleanViteUrl(id: string): string {
	const i = id.indexOf('?')
	return i >= 0 ? id.slice(0, i) : id
}

export function unwrapViteId(id: string): string {
	if (!id.startsWith('/@id/')) return id
	const encoded = id.slice('/@id/'.length)
	try {
		return decodeURIComponent(encoded)
	} catch {
		return encoded
	}
}

/**
 * Converts a Vite `/@fs/` id into a filesystem path.
 *
 * Notes:
 * - Vite uses `/@fs${absPath}` for POSIX (e.g. `/@fs/home/a/file.ts`).
 * - Vite uses `/@fs/${drivePath}` for Windows (e.g. `/@fs/C:/a/file.ts`).
 *
 * This helper returns:
 * - POSIX: `/home/a/file.ts`
 * - Windows: `C:/a/file.ts`
 */
export function fsPathFromViteFsId(id: string): string | null {
	const cleaned = cleanViteUrl(id)
	if (!cleaned.startsWith('/@fs/')) return null

	const rest = cleaned.slice('/@fs/'.length)
	if (!rest) return null

	// If the rest is already absolute (double-slash form), keep it (but drop `/` before drive paths).
	if (rest.startsWith('/')) {
		const maybeDrive = rest.slice(1)
		if (DRIVE_PATH_RE.test(maybeDrive)) return maybeDrive
		return rest
	}

	// Windows drive paths are absolute without a leading slash.
	if (DRIVE_PATH_RE.test(rest)) return rest

	// POSIX absolute paths must have a leading slash.
	return `/${rest}`
}

export function isBarePackageSpecifier(specifier: string): boolean {
	// Fast-path: only bare package specifiers can be rewritten to workspace entries.
	// Avoid allocating cache entries for relative, absolute, or virtual ids.
	if (
		!specifier ||
		specifier.startsWith('.') ||
		specifier.startsWith('/') ||
		specifier.startsWith('\0') ||
		// Windows absolute paths.
		DRIVE_PATH_RE.test(specifier) ||
		// Schemed ids: node:, file:, data:, virtual:, etc.
		specifier.includes(':')
	) {
		return false
	}
	return true
}
