import type { Context } from '@pluxel/core'
import { RuntimeStateStore } from '../services/RuntimeStateStore'

const RUNTIME_STATE_SERVICE_KEY = 'runtimeState' as const

/** @internal Runtime host authority; intentionally absent from the public Context surface. */
export function requireRuntimeStateStore(ctx: Context): RuntimeStateStore {
	const service = (ctx.root as unknown as Record<PropertyKey, unknown>)[RUNTIME_STATE_SERVICE_KEY]
	if (
		!service ||
		typeof service !== 'object' ||
		typeof (service as { snapshot?: unknown }).snapshot !== 'function' ||
		typeof (service as { versionedSnapshot?: unknown }).versionedSnapshot !== 'function' ||
		typeof (service as { commitVersioned?: unknown }).commitVersioned !== 'function'
	) {
		throw new Error('[pluxel/runtime] RuntimeStateStore is not installed on this Context')
	}
	return service as RuntimeStateStore
}
