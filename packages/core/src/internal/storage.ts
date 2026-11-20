import type { HostDocumentStorage } from '../storage/documents'
import { requireCoreFilesystem, requireCoreRuntime } from '../context/core-context'
import type { RootContext } from '../context/Context'

/** @internal Borrow this root's fixed runtime data filesystem. */
export function requireFs(root: RootContext) {
	return requireCoreFilesystem(root)
}

function hostDocumentDirectory(namespace: string): string {
	if (!/^[a-z][a-z0-9-]*$/.test(namespace))
		throw new TypeError('[core.fs] Host document namespace must be a lowercase identifier')
	return `services/host/${namespace}`
}

/** @internal Borrow ordinary Host documents from their domain-owned namespace. */
export function requireHostDocuments(root: RootContext, namespace: string): HostDocumentStorage {
	return requireCoreRuntime(root).storage.documents.documents(hostDocumentDirectory(namespace))
}

/** @internal Retention is established by the root's document adapter. */
export function requireHostDocumentRetention(root: RootContext, namespace: string) {
	return requireCoreRuntime(root).storage.documents.documentRetention(
		hostDocumentDirectory(namespace),
	)
}

/** @internal Plugin Store status and explicit writer recovery. */
export function requireTinyBaseHost(root: RootContext) {
	return requireCoreRuntime(root).tinybase
}

/** @internal Root-owned credential administration and deployment injection. */
export function requireVaultHost(root: RootContext) {
	return requireCoreRuntime(root).vault
}
