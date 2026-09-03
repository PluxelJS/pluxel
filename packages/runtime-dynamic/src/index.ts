import type { Context } from '@pluxel/runtime'
import { defineDynamicRuntimeConfig } from './config'
import { resolveDynamicRuntimeEntry } from './entry'

export { defineDynamicRuntimeConfig }
export type { DynamicRuntimeConfig, DynamicRuntimeStorageOptions } from './config'
export type { DynamicPluginSource } from './sources'

export interface DynamicDevRuntime extends AsyncDisposable {
	/** The production root Context. Access after disposal throws. */
	readonly ctx: Context
	/** Normalized loopback HTTP origin of the ready Vite listener, without a trailing slash. */
	readonly origin: string
	/** Idempotently releases the listener, Runtime effects, HMR graph, and Vite resources. */
	dispose(): Promise<void>
}

/**
 * Starts the canonical dynamic Vite route and resolves only after its physical listener is ready.
 *
 * Relative string entries use the working directory captured when this function is called. A URL
 * must use the `file:` protocol. `signal` cancels startup; it is detached once the resource is ready.
 * Startup rejection first closes every Vite and Runtime resource acquired by this launcher.
 */
export async function startDynamicDevRuntime(
	options: Readonly<{ entry: string | URL; signal?: AbortSignal }>,
): Promise<DynamicDevRuntime> {
	const root = process.cwd()
	const entry = resolveDynamicRuntimeEntry(options?.entry, root, 'runtime-dynamic')
	throwIfAborted(options.signal)
	const { startOwnedDynamicRuntimeViteServer } = await import('./launcher-internal')
	throwIfAborted(options.signal)
	const owned = await startOwnedDynamicRuntimeViteServer({
		entry,
		root,
		...(options.signal ? { signal: options.signal } : {}),
	})
	let disposed = false
	let disposePromise: Promise<void> | undefined
	const dispose = (): Promise<void> => {
		disposed = true
		return (disposePromise ??= owned.server.close())
	}
	return Object.freeze({
		get ctx() {
			if (disposed)
				throw new Error('[runtime-dynamic] runtime is closed; its Context is no longer available')
			const controller = readDynamicRuntimeController(owned.server)
			if (!controller)
				throw new Error('[runtime-dynamic] dynamic runtime controller is unavailable')
			return controller.booted.ctx as Context
		},
		origin: owned.origin,
		dispose,
		[Symbol.asyncDispose]: dispose,
	})
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (!signal?.aborted) return
	throw signal.reason ?? new DOMException('The operation was aborted', 'AbortError')
}

function readDynamicRuntimeController(
	server: import('vite').ViteDevServer,
): { booted: { ctx: Context } } | undefined {
	const key = Symbol.for('pluxel.dynamicRuntimeController')
	return (server as unknown as Record<PropertyKey, unknown>)[key] as
		| { booted: { ctx: Context } }
		| undefined
}
