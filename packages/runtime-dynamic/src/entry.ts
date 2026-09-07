import { fileURLToPath } from 'node:url'
import { normalize, resolve } from 'pathe'

/** @internal Shared by the Vite-owned and direct-launch entry boundaries. */
export function resolveDynamicRuntimeEntry(
	entry: string | URL,
	baseDirectory: string,
	boundary: string,
): string {
	if (entry instanceof URL) {
		if (entry.protocol !== 'file:') {
			throw new TypeError(`[${boundary}] entry URL must use the file: protocol`)
		}
		if (entry.search || entry.hash) {
			throw new TypeError(`[${boundary}] entry file URL must not include query or fragment data`)
		}
		return normalize(fileURLToPath(entry))
	}
	if (typeof entry !== 'string') {
		throw new TypeError(`[${boundary}] entry must be a filesystem path or file: URL`)
	}
	const path = entry.trim()
	if (!path) throw new TypeError(`[${boundary}] entry is required`)
	return normalize(resolve(baseDirectory, path))
}
