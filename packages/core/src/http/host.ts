import type { RootContext } from '../context/Context'
import { requireCoreRuntime } from '../context/core-context'
import type { PluginNodeAddress } from '../plugins/runtime/identity'
import type { OutboundHttpRuntime } from './runtime'

/** Borrow the root-owned management operations for this Host. */
export function requireOutboundHttp(root: RootContext): OutboundHttpRuntime['management'] {
	if (root !== root.root) throw new TypeError('[core.http] management requires a root Context')
	return requireCoreRuntime(root).http.management
}

/** Called under the Host metadata mutation gate when a node is removed. */
export function clearOutboundHttpNode(root: RootContext, owner: PluginNodeAddress): Promise<void> {
	return requireCoreRuntime(root).http.clearNode(owner)
}
