/** Borrowed storage for Host-owned config/state documents. The application owns backend closure. */
export interface HostDocumentStorage {
	getText(key: string): Promise<string | undefined>
	/** Resolve only after the complete document is committed; atomic requests must preserve the old or new document. */
	put(key: string, value: string, options?: { atomic?: boolean }): Promise<void>
	/** Only existence is required; providers may return their existing file metadata. */
	stat(key: string): Promise<object | undefined>
}

export type HostStoreStorageOptions =
	| Readonly<{ storage?: never; mode?: 'memory' }>
	| Readonly<{
			/** Borrowed document namespace. No filesystem or service backend is created implicitly. */
			storage: HostDocumentStorage
			/** Omitted means writable. Readonly preserves startup values when no document exists. */
			mode?: 'writable' | 'readonly'
	  }>

/** @internal Reject impossible mode/storage pairs before starting document IO. */
export function assertHostStoreStorage(options: HostStoreStorageOptions): void {
	if (options.storage === undefined) {
		if (options.mode !== undefined && options.mode !== 'memory')
			throw new TypeError('[host] persistent store mode requires document storage')
		return
	}
	if (options.mode !== undefined && options.mode !== 'writable' && options.mode !== 'readonly')
		throw new TypeError('[host] supplied document storage requires writable or readonly mode')
	for (const method of ['getText', 'put', 'stat'] as const) {
		if (typeof options.storage[method] !== 'function')
			throw new TypeError(`[host] document storage requires ${method}()`)
	}
}
