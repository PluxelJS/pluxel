import { defineContextCapability, installRootCapability } from '@pluxel/core/host'
import { createHost, defineHostService, type HostDocumentStorage } from '../src/index'

/** Compile-only contract: declaration tuples reject provable duplicate properties. */
export function checkHostServiceTypes() {
	const Provider = defineContextCapability<number>('typecheck.provider')
	const provider = defineHostService({
		name: 'provider',
		capabilities: [installRootCapability(Provider, { property: 'provider', create: () => 1 })],
	})
	// @ts-expect-error A tuple with duplicate projected properties is rejected before runtime.
	void createHost({ plugins: [], services: [provider, provider] })
}

/** Compile-only contract: Host storage is a synchronous root binding and commits are always atomic. */
export function checkHostDocumentStorageTypes(storage: HostDocumentStorage) {
	void createHost({
		plugins: [],
		runtime: { documents: { state: { storage: () => storage, readOnly: true } } },
	})
	void createHost({
		plugins: [],
		runtime: { documents: { config: { readOnly: true }, state: { readOnly: true } } },
	})
	void createHost({ plugins: [], runtime: { documents: { config: {}, state: {} } } })
	void createHost({ plugins: [], runtime: { documents: { config: false, state: false } } })
	// @ts-expect-error A borrowed storage object must be bound through the root factory.
	void createHost({ plugins: [], runtime: { documents: { state: { storage } } } })
	void createHost({
		plugins: [],
		// @ts-expect-error Document factories return a namespace synchronously.
		runtime: { documents: { config: { storage: async () => storage } } },
	})
	// @ts-expect-error Documents cannot be enabled with an ambiguous boolean.
	void createHost({ plugins: [], runtime: { documents: { state: true } } })
	// @ts-expect-error Document commits do not offer a non-atomic mode.
	void storage.put('config.json', '{}', { atomic: false })
}
