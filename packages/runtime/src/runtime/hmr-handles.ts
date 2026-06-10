import type { Context } from '@pluxel/core'

/**
 * Optional HMR handles attached to a runtime Context.
 *
 * This is intentionally NOT a DI service: runtime must be valid without it, and
 * HMR hosts (Vite/runtime-dynamic) should own their own lifecycle explicitly.
 */
export type HmrRuntimeHandles = {
	hmr?: {
		api: {
			lastBatch: () => unknown
			waitForBatch: (options?: unknown) => Promise<unknown>
			waitForStable: (options?: unknown) => Promise<unknown>
			waitForIdle: (options?: unknown) => Promise<void>
		}
		executeFiles?: (files: string[], keepOrder?: boolean) => Promise<void>
	}
	extensions?: {
		// HMR consumes author-facing source declarations and pushes compiled MF artifacts into runtime.
		bindUiSource: (ctx: Context, options: { entryPath: string }) => () => void
	}
	bundler?: {
		watchTinypoolWorker: (
			ctx: Context,
			tsEntry: string,
			options: {
				external?: string[]
				onUpdate: (workerUrl: string) => void | Promise<void>
				onError?: (error: unknown) => void
			},
		) => Promise<() => Promise<void>>
	}
}

function resolveHandleOwner(ctx: Context): Context {
	return ((ctx as unknown as { root?: Context }).root ?? ctx) as Context
}

const store = new WeakMap<Context, HmrRuntimeHandles>()

export function setHmrRuntimeHandles(ctx: Context, handles: HmrRuntimeHandles): void {
	store.set(resolveHandleOwner(ctx), handles)
}

export function getHmrRuntimeHandles(ctx: Context): HmrRuntimeHandles | null {
	return store.get(resolveHandleOwner(ctx)) ?? null
}

export function clearHmrRuntimeHandles(ctx: Context): void {
	store.delete(resolveHandleOwner(ctx))
}
