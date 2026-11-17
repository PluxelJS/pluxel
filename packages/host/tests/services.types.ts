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
