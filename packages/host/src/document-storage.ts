import type { RootContext } from '@pluxel/core'

/** Borrowed storage for Host-owned config/state documents. The provider owns backend closure. */
export interface HostDocumentStorage {
	/** Only a missing document returns undefined; other failures reject. */
	getText(key: string): Promise<string | undefined>
	/** Resolve after a complete atomic commit; readers observe the previous or complete new document. */
	put(key: string, value: string): Promise<void>
	/** Only existence is required; providers may return their existing file metadata. */
	stat(key: string): Promise<object | undefined>
}

export type HostStoreStorageOptions =
	| Readonly<{ storage?: never; mode?: 'memory' }>
	| Readonly<{
			/** Called once after root creation, before document IO or service prepare. Return a borrowed namespace synchronously. */
			storage: (root: RootContext) => HostDocumentStorage
			/** Omitted means writable. Readonly preserves startup values when no document exists. */
			mode?: 'writable' | 'readonly'
	  }>

/** @internal Stores consume already resolved namespaces; only createHost invokes application factories. */
export type ResolvedHostStoreStorageOptions =
	| Readonly<{ storage?: never; mode?: 'memory' }>
	| Readonly<{ storage: HostDocumentStorage; mode?: 'writable' | 'readonly' }>

/** @internal Reject impossible mode/storage pairs before starting document IO. */
export function assertHostStoreStorage(options: HostStoreStorageOptions): void {
	assertStorageMode(options)
	if (options.storage !== undefined && typeof options.storage !== 'function')
		throw new TypeError('[host] document storage must be a synchronous root factory')
}

/** @internal Resolve and validate before constructing either Host document store. */
export function resolveHostStoreStorage(
	options: HostStoreStorageOptions,
	root: RootContext,
): ResolvedHostStoreStorageOptions {
	if (options.storage === undefined) return { mode: 'memory' }
	const storage = options.storage(root)
	assertDocumentStorage(storage)
	return { storage, mode: options.mode === 'readonly' ? 'readonly' : 'writable' }
}

/** @internal Reject invalid namespaces before starting store IO. */
export function assertResolvedHostStoreStorage(options: ResolvedHostStoreStorageOptions): void {
	assertStorageMode(options)
	if (options.storage === undefined) return
	assertDocumentStorage(options.storage)
}

function assertDocumentStorage(storage: unknown): asserts storage is HostDocumentStorage {
	if (!storage || typeof storage !== 'object' || Array.isArray(storage))
		throw new TypeError('[host] document storage factory must synchronously return an object')
	for (const method of ['getText', 'put', 'stat'] as const) {
		if (typeof (storage as HostDocumentStorage)[method] !== 'function')
			throw new TypeError(`[host] document storage requires ${method}()`)
	}
}

function assertStorageMode(options: { storage?: unknown; mode?: string }): void {
	if (options.storage === undefined) {
		if (options.mode !== undefined && options.mode !== 'memory')
			throw new TypeError('[host] persistent store mode requires document storage')
		return
	}
	if (options.mode !== undefined && options.mode !== 'writable' && options.mode !== 'readonly')
		throw new TypeError('[host] supplied document storage requires writable or readonly mode')
}
