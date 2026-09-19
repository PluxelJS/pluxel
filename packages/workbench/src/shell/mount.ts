import type { Context } from '@pluxel/core'
const mounts = new WeakMap<Context, string>()
export function workbenchShellMount(ctx: Context): string | undefined {
	return mounts.get(ctx.root)
}
export function publishWorkbenchShellMount(ctx: Context, path: string): () => void {
	const root = ctx.root
	if (mounts.has(root)) throw new Error('[workbench] shell is already mounted')
	mounts.set(root, path)
	return () => {
		mounts.delete(root)
	}
}
