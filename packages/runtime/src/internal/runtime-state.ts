import type { Context } from '@pluxel/core'
import { resolveContextCapability } from '@pluxel/core/internal'
import { RUNTIME_STATE_CAPABILITY } from '../context/runtime-state-capability'
import type { RuntimeStateStore } from '../services/RuntimeStateStore'

/** @internal Runtime host authority; intentionally absent from the public Context surface. */
export function requireRuntimeStateStore(ctx: Context): RuntimeStateStore {
	return resolveContextCapability(ctx, RUNTIME_STATE_CAPABILITY)
}
