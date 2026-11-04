import type { CoreHostConfig } from '@pluxel/core'
import { snapshotHostDocuments, type HostDocumentFacilities } from './document-storage'

/** Fixed runtime facilities; Plugin inputs and execution policy have separate author fields. */
export type HostRuntimeOptions = Readonly<{
	zenfs?: CoreHostConfig['zenfs']
	logtape?: CoreHostConfig['logtape']
	tinybase?: CoreHostConfig['tinybase']
	events?: CoreHostConfig['events']
	documents?: HostDocumentFacilities
}>

export function snapshotHostRuntime(input: HostRuntimeOptions = {}): HostRuntimeOptions {
	if (!input || typeof input !== 'object' || Array.isArray(input))
		throw new TypeError('[host] runtime must be an object')
	for (const key of Reflect.ownKeys(input)) {
		if (
			typeof key !== 'string' ||
			!['zenfs', 'logtape', 'events', 'tinybase', 'documents'].includes(key)
		)
			throw new TypeError(`[host] runtime includes unsupported "${String(key)}"`)
		if (!('value' in Object.getOwnPropertyDescriptor(input, key)!))
			throw new TypeError('[host] runtime cannot contain accessors')
	}
	return Object.freeze({
		...input,
		...(input.documents === undefined ? {} : { documents: snapshotHostDocuments(input.documents) }),
	})
}
