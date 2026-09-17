import { resolveContextCapability } from '@pluxel/core/host'
import type { Context } from '@pluxel/core'
import { createPluginLogPolicyStore } from '@pluxel/logging'
import { Persistence } from '@pluxel/services/persistence'
/** Runtime composition chooses the logging namespace; Host logging accepts explicit storage. */
export function createContextPluginLogPolicyStore(ctx: Context) {
	const persistence = resolveContextCapability(ctx.root, Persistence)
	return persistence ? createPluginLogPolicyStore(persistence.namespace('logger')) : undefined
}
