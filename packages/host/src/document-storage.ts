import type { RootContext, HostDocumentStorage } from '@pluxel/core'
import { requireHostDocumentRetention, requireHostDocuments } from '@pluxel/core/internal'
import type { HostPersistenceRetention } from './persistence'
export type { HostDocumentStorage } from '@pluxel/core'

export type HostDocumentOptions = Readonly<{
	readOnly?: boolean
	/** Called once after root creation and before document IO; the returned namespace is borrowed. */
	storage?: (root: RootContext) => HostDocumentStorage
}>
/** @internal Absence of storage means session input without document IO. */
export type ResolvedHostStoreStorageOptions = Readonly<{
	storage?: HostDocumentStorage
	readOnly?: boolean
	retention?: HostPersistenceRetention
}>

export function snapshotHostDocument(
	input: false | HostDocumentOptions | undefined,
	label: string,
): false | HostDocumentOptions | undefined {
	if (input === undefined || input === false) return input
	assertHostDocumentOptions(input, label)
	return Object.freeze({ ...input })
}

function assertHostDocumentOptions(options: HostDocumentOptions, label: string): void {
	assertRecord(options, ['storage', 'readOnly'], label)
	if (options.readOnly !== undefined && typeof options.readOnly !== 'boolean')
		throw new TypeError(`[host] ${label}.readOnly must be a boolean`)
	if (options.storage !== undefined && typeof options.storage !== 'function')
		throw new TypeError('[host] document storage must be a synchronous root factory')
}

export function resolveHostStoreStorage(
	options: false | HostDocumentOptions | undefined,
	root: RootContext,
	namespace: 'config' | 'state',
): ResolvedHostStoreStorageOptions {
	if (options === false) return Object.freeze({ readOnly: false, retention: 'session' })
	if (options?.storage === undefined)
		return Object.freeze({
			storage: requireHostDocuments(root, namespace),
			readOnly: options?.readOnly ?? false,
			retention: requireHostDocumentRetention(root, namespace),
		})
	const storage = options.storage(root)
	assertDocumentStorage(storage)
	return Object.freeze({ storage, readOnly: options.readOnly ?? false, retention: 'unknown' })
}

export function assertResolvedHostStoreStorage(options: ResolvedHostStoreStorageOptions): void {
	assertRecord(options, ['storage', 'readOnly', 'retention'], 'resolved document storage')
	if (options.readOnly !== undefined && typeof options.readOnly !== 'boolean')
		throw new TypeError('[host] document readOnly must be a boolean')
	if (
		options.retention !== undefined &&
		!['session', 'declared-durable', 'unknown'].includes(options.retention)
	)
		throw new TypeError('[host] invalid document retention')
	if (options.storage !== undefined) assertDocumentStorage(options.storage)
}

function assertDocumentStorage(storage: unknown): asserts storage is HostDocumentStorage {
	if (!storage || typeof storage !== 'object' || Array.isArray(storage))
		throw new TypeError('[host] document storage factory must synchronously return an object')
	for (const method of ['getText', 'put', 'stat'] as const)
		if (typeof (storage as HostDocumentStorage)[method] !== 'function')
			throw new TypeError(`[host] document storage requires ${method}()`)
	if ('then' in storage) throw new TypeError('[host] document storage factory must be synchronous')
}

function assertRecord(
	input: unknown,
	keys: readonly string[],
	label: string,
): asserts input is Record<string, unknown> {
	if (
		!input ||
		typeof input !== 'object' ||
		Array.isArray(input) ||
		![Object.prototype, null].includes(Object.getPrototypeOf(input))
	)
		throw new TypeError(`[host] ${label} must be a plain object`)
	for (const key of Reflect.ownKeys(input)) {
		if (typeof key !== 'string' || !keys.includes(key))
			throw new TypeError(`[host] ${label} includes unsupported ${String(key)}`)
		if (!Object.getOwnPropertyDescriptor(input, key)!.enumerable)
			throw new TypeError(`[host] ${label} cannot contain hidden fields`)
		if (!('value' in Object.getOwnPropertyDescriptor(input, key)!))
			throw new TypeError(`[host] ${label} cannot contain accessors`)
	}
}
