import { resolveContextCapability } from '@pluxel/core/host'
import type { Context } from '@pluxel/core'
import { NodeModuleHost } from './token'
export type { NodeModuleSourceBinder, NodeModuleSourceSubscription } from './service'

/** Development attachments may access the root provider; Plugin views expose only use(). */
export function requireNodeModuleHost(root: Context) {
	if (root !== root.root) throw new TypeError('Node artifact host requires a root Context')
	return resolveContextCapability(root, NodeModuleHost)
}
