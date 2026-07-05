import { fileURLToPath } from 'node:url'
import { normalize } from 'pathe'

export function normalizeViteId(id: string): string {
	const cleaned = id.split('?')[0]!
	if (cleaned.startsWith('/@fs/')) return normalizePath(cleaned.slice('/@fs'.length))
	if (cleaned.startsWith('file://')) {
		try {
			return normalizePath(fileURLToPath(cleaned))
		} catch {
			return normalizePath(cleaned)
		}
	}
	return normalizePath(cleaned)
}

function normalizePath(path: string): string {
	return normalize(path)
}
