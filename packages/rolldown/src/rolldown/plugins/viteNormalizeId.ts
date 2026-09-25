import { fileURLToPath } from 'node:url'
import { normalize } from 'pathe'

export function normalizeViteId(id: string): string {
	const cleaned = id.split('?')[0]!
	if (cleaned.startsWith('/@fs/')) return normalize(cleaned.slice('/@fs'.length))
	if (cleaned.startsWith('file://')) {
		try {
			return normalize(fileURLToPath(cleaned))
		} catch {
			return normalize(cleaned)
		}
	}
	return normalize(cleaned)
}
