import type { Context } from '@pluxel/core'
import type { PluginRecentUpdateRead } from '@pluxel/host/internal'

export type ManagementHostOptions = Readonly<{ recentUpdate?: PluginRecentUpdateRead }>
const inputs = new WeakMap<Context['root'], ManagementHostOptions>()
export function readManagementHostOptions(ctx: Context): ManagementHostOptions | undefined {
	return inputs.get(ctx.root)
}
/** One immutable input set per Host; route drivers may supply a stable live update reader. */
export function bindManagementHostOptions(
	ctx: Context,
	options: ManagementHostOptions,
): () => void {
	if (inputs.has(ctx.root)) throw new Error('Management inputs are already installed')
	inputs.set(ctx.root, Object.freeze({ ...options }))
	return () => {
		inputs.delete(ctx.root)
	}
}
