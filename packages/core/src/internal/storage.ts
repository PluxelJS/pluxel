import { resolveContextCapability } from '@pluxel/context'
import type { RootContext } from '../context/Context'
import { FS_CAPABILITY, TINYBASE_HOST_CAPABILITY } from '../context/core-capabilities'

/** @internal Borrow this root's fixed runtime data filesystem. */
export function requireFs(root: RootContext) {
	return resolveContextCapability(root, FS_CAPABILITY)
}

/** @internal Host-only confirmed documents, status and explicit writer recovery. */
export function requireTinyBaseHost(root: RootContext) {
	return resolveContextCapability(root, TINYBASE_HOST_CAPABILITY)
}
