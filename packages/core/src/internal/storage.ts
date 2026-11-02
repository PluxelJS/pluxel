import { resolveContextCapability } from '@pluxel/context'
import type { RootContext } from '../context/Context'
import { FS_CAPABILITY, TINYBASE_HOST_CAPABILITY } from '../context/core-capabilities'

/** @internal Borrow this root's fixed runtime data filesystem. */
export function requireFs(root: RootContext) {
	return resolveContextCapability(root, FS_CAPABILITY)
}

/** @internal Borrow ordinary Host documents from their readable, domain-owned directory. */
export function requireHostDocuments(root: RootContext, namespace: string) {
	if (!/^[a-z][a-z0-9-]*$/.test(namespace))
		throw new TypeError('[core.fs] Host document namespace must be a lowercase identifier')
	return requireFs(root).documents(`services/host/${namespace}`)
}

/** @internal Plugin Store status and explicit writer recovery. */
export function requireTinyBaseHost(root: RootContext) {
	return resolveContextCapability(root, TINYBASE_HOST_CAPABILITY)
}
