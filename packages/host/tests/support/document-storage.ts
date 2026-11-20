import type { HostDocumentStorage } from '../../src/index'

export function createDocumentStorage(): HostDocumentStorage & {
	readonly documents: Map<string, string>
} {
	const documents = new Map<string, string>()
	return {
		documents,
		async getText(key) {
			return documents.get(key)
		},
		async put(key, value) {
			documents.set(key, value)
		},
		async stat(key) {
			return documents.has(key) ? {} : undefined
		},
	}
}
