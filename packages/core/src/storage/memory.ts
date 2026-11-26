import { withErrno } from 'kerium/error'
import type { RootContext } from '../context/Context'
import {
	assertDocumentBudget,
	assertDocumentKey,
	MAX_DOCUMENT_BYTES,
	type CoreStorage,
	type HostDocumentStorage,
} from './documents'

const present = Object.freeze({})

/** Session documents are owned by one Core root, with no external change source. */
export function createMemoryStorage(root: RootContext): CoreStorage {
	const namespaces = new Map<
		string,
		{ storage: HostDocumentStorage; maxBytes: number; contents: Map<string, string> }
	>()
	let closed = false
	root.effects.defer(
		() => {
			closed = true
			for (const { contents } of namespaces.values()) contents.clear()
			namespaces.clear()
		},
		{ tag: 'MemoryDocuments', phase: 'final' },
	)
	const assertOpen = () => {
		if (closed) throw withErrno('EBADF', 'Host documents are closed')
	}
	return {
		documents: {
			documentRetention: () => 'session',
			documents(directory, maxBytes = MAX_DOCUMENT_BYTES) {
				assertOpen()
				assertDocumentKey(directory)
				if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
					throw new TypeError('[core.storage] document byte limit must be a positive safe integer')
				const existing = namespaces.get(directory)
				if (existing) {
					if (existing.maxBytes !== maxBytes)
						throw new TypeError('[core.storage] a document directory has one fixed byte limit')
					return existing.storage
				}
				const contents = new Map<string, string>()
				const storage: HostDocumentStorage = {
					async getText(key) {
						assertOpen()
						assertDocumentKey(key)
						return contents.get(key)
					},
					async put(key, text) {
						assertOpen()
						assertDocumentKey(key)
						assertDocumentBudget(text, maxBytes)
						contents.set(key, text)
					},
					async stat(key) {
						assertOpen()
						assertDocumentKey(key)
						return contents.has(key) ? present : undefined
					},
				}
				namespaces.set(directory, { storage, maxBytes, contents })
				return storage
			},
		},
	}
}
