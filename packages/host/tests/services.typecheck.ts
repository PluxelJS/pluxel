import { createHost, type HostDocumentStorage } from '../src/index'

/** Compile-only contract: one accessor preserves required and optional service results. */
export function checkHostServiceTypes(
	host: import('../src/index').PluginHost,
	optional: import('@pluxel/core').ServiceRef<{ id: number }>,
) {
	abstract class Provider {
		abstract id: number
	}
	const required: { id: number } = host.ctx.service(Provider)
	const maybe: { id: number } | undefined = host.ctx.service(optional)
	return { required, maybe }
}

/** Compile-only contract: Host storage is a synchronous root binding and commits are always atomic. */
export function checkHostDocumentStorageTypes(storage: HostDocumentStorage) {
	void createHost({ policy: { document: { storage: () => storage, readOnly: true } } })
	void createHost({ config: { document: { readOnly: true } } })
	void createHost({ policy: { document: {} }, config: { document: false } })
	// @ts-expect-error A borrowed storage object must be bound through the root factory.
	void createHost({ policy: { document: { storage } } })
	// @ts-expect-error Document factories must return storage synchronously.
	void createHost({ config: { document: { storage: async () => storage } } })
	// @ts-expect-error Document IO is enabled by default.
	void createHost({ policy: { document: true } })
	// @ts-expect-error Document commits do not offer a non-atomic mode.
	void storage.put('config.json', '{}', { atomic: false })
}
