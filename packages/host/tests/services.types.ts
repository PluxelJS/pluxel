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
	void createHost({ plugins: [], state: { storage: () => storage, mode: 'readonly' } })
	// @ts-expect-error A borrowed storage object must be bound through the root factory.
	void createHost({ plugins: [], state: { storage } })
	// @ts-expect-error Document factories return a namespace synchronously.
	void createHost({ plugins: [], configRecords: { storage: async () => storage } })
	// @ts-expect-error Persistent modes require a storage factory.
	void createHost({ plugins: [], state: { mode: 'readonly' } })
	// @ts-expect-error Document commits do not offer a non-atomic mode.
	void storage.put('config.json', '{}', { atomic: false })
}
