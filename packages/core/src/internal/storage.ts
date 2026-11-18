import type { HostDocumentStorage } from '../storage/documents'
import { requireCoreRuntime } from '../context/core-context'
import type { RootContext } from '../context/Context'

/** @internal Borrow this root's fixed runtime data filesystem. */
export function requireFs(root: RootContext) {
	return requireCoreRuntime(root).fs
}

/** @internal Borrow ordinary Host documents from their readable, domain-owned directory. */
export function requireHostDocuments(root: RootContext, namespace: string): HostDocumentStorage {
	if (!/^[a-z][a-z0-9-]*$/.test(namespace))
		throw new TypeError('[core.fs] Host document namespace must be a lowercase identifier')
	return requireFs(root).documents(`services/host/${namespace}`)
}

/** @internal Plugin Store status and explicit writer recovery. */
export function requireTinyBaseHost(root: RootContext) {
	return requireCoreRuntime(root).tinybase
}

/** @internal Root-owned credential administration and deployment injection. */
export function requireVaultHost(root: RootContext) {
	return requireCoreRuntime(root).vault
}
