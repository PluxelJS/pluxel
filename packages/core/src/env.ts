import { Context } from '@pluxel/context'
import * as stdEnv from 'std-env'

export type PluxelRuntime = 'core' | 'hmr'

declare module '@pluxel/context' {
	interface Context {
		/** Process-wide environment helpers (std-env + pluxel runtime). */
		env: PluxelEnv
	}
}

const RUNTIME_SYMBOL = Symbol.for('pluxel:runtime')

function readGlobalRuntime(): PluxelRuntime | undefined {
	const value = (globalThis as any)[RUNTIME_SYMBOL] as unknown
	return value === 'core' || value === 'hmr' ? value : undefined
}

export function getPluxelRuntime(): PluxelRuntime {
	return readGlobalRuntime() ?? 'core'
}

/**
 * Set the current Pluxel runtime for this JS process.
 *
 * Note: this is process-global. Use it only in runtime entrypoints (e.g. @pluxel/hmr).
 */
export function setPluxelRuntime(runtime: PluxelRuntime): void {
	;(globalThis as any)[RUNTIME_SYMBOL] = runtime
}

export function isCoreRuntime(): boolean {
	return getPluxelRuntime() === 'core'
}

export function isHmrRuntime(): boolean {
	return getPluxelRuntime() === 'hmr'
}

export type PluxelEnv = typeof stdEnv & {
	readonly runtime: PluxelRuntime
	readonly isCoreRuntime: boolean
	readonly isHmrRuntime: boolean
}

const ENV_SYMBOL = Symbol.for('pluxel:env')
const cachedEnv = (globalThis as any)[ENV_SYMBOL] as PluxelEnv | undefined

function createPluxelEnv(): PluxelEnv {
	// Inherit std-env exports via prototype (no copy; no per-ctx allocations).
	// Note: stdEnv is a module namespace object (immutable); it's safe as prototype.
	const obj: any = Object.create(stdEnv)

	// pluxel runtime flags (getters; reflect runtime changes).
	Object.defineProperty(obj, 'runtime', {
		get: getPluxelRuntime,
		enumerable: true,
		configurable: false,
	})
	Object.defineProperty(obj, 'isCoreRuntime', {
		get: isCoreRuntime,
		enumerable: true,
		configurable: false,
	})
	Object.defineProperty(obj, 'isHmrRuntime', {
		get: isHmrRuntime,
		enumerable: true,
		configurable: false,
	})

	return obj as PluxelEnv
}

export const pluxelEnv: PluxelEnv =
	cachedEnv ?? ((globalThis as any)[ENV_SYMBOL] = createPluxelEnv())

// Default to "core" unless a higher-level runtime (e.g. @pluxel/hmr) overrides it.
if (readGlobalRuntime() === undefined) {
	setPluxelRuntime('core')
}

// Provide a stable env surface on all Context instances.
if (!Object.hasOwn(Context.prototype, 'env')) {
	Object.defineProperty(Context.prototype, 'env', {
		get(this: Context) {
			return pluxelEnv
		},
		enumerable: false,
		configurable: true,
	})
}

export * from 'std-env'
