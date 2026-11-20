import type { FsService } from '../fs/service'

export const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024

/** Borrowed storage for Host-owned config/state documents. The provider owns backend closure. */
export interface HostDocumentStorage {
	/** Only a missing document returns undefined; other failures reject. */
	getText(key: string): Promise<string | undefined>
	/** Resolve after a complete atomic commit; readers observe the previous or complete new document. */
	put(key: string, value: string): Promise<void>
	/** Only existence is required; providers may return their existing file metadata. */
	stat(key: string): Promise<object | undefined>
	/** External changes to this namespace. Reread documents when notified; unsubscribe before closing the consumer.
	 * Omitted by adapters that do not observe external writes. Local puts need not notify.
	 */
	subscribe?(listener: () => void): () => void
}

/** Root-owned documents and the file capability, when the Host supplies one. */
export type CoreStorage = Readonly<{
	documents: Readonly<{
		documents(directory: string, maxBytes?: number): HostDocumentStorage
		documentRetention(directory: string): 'session' | 'declared-durable' | 'unknown'
	}>
	files?: FsService
}>

export function assertDocumentKey(key: string): void {
	if (
		typeof key !== 'string' ||
		key.length === 0 ||
		key.length > 16_384 ||
		key.includes('\\') ||
		key.includes('\0') ||
		/^[A-Za-z]:/.test(key) ||
		key.split('/').some((part) => part === '' || part === '.' || part === '..')
	)
		throw new TypeError('[core.storage] document key must be a canonical relative file path')
}

export function assertDocumentBudget(text: string, maxBytes: number): void {
	if (typeof text !== 'string')
		throw new TypeError('[core.storage] document content must be a string')
	if (new TextEncoder().encode(text).byteLength > maxBytes)
		throw new RangeError(`[core.storage] document exceeds ${maxBytes} UTF-8 bytes`)
}
