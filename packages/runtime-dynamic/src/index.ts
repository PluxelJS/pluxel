import type { Context } from '@pluxel/runtime'
import { defineDynamicRuntimeConfig } from './config'

export { defineDynamicRuntimeConfig }
export type { DynamicRuntimeConfig, DynamicRuntimeStorageOptions } from './config'
export type { DynamicPluginSource } from './sources'

export type DynamicDevRuntime = {
	/** Available only after `start()` resolves. */
	readonly ctx: Context
	/** Starts the owned Vite/HMR server and initial runtime. Repeated successful calls are idempotent. */
	start(): Promise<void>
	/** Stops all runtime effects and owned server resources. Repeated calls are idempotent. */
	stop(): Promise<void>
}

/** Plans an unstarted dynamic runtime. Call `start()` before reading its Context. */
export async function createDynamicDevRuntime(
	options: Readonly<{ config: string }>,
): Promise<DynamicDevRuntime> {
	const configPath = String(options?.config ?? '').trim()
	if (!configPath)
		throw new TypeError('[runtime-dynamic] createDynamicDevRuntime config is required')
	let server: import('vite').ViteDevServer | undefined
	let startPromise: Promise<void> | undefined
	let stopped = false

	const start = async (): Promise<void> => {
		if (stopped) throw new Error('[runtime-dynamic] cannot start a stopped runtime')
		if (server) return
		startPromise ??= import('./launcher-internal')
			.then(({ startOwnedDynamicRuntimeViteServer }) =>
				startOwnedDynamicRuntimeViteServer({ config: configPath }),
			)
			.then((result) => {
				server = result
				return undefined
			})
			.catch((error) => {
				startPromise = undefined
				throw error
			})
		await startPromise
	}

	return {
		get ctx() {
			if (stopped) {
				throw new Error('[runtime-dynamic] runtime has stopped; its Context is no longer available')
			}
			if (!server) {
				throw new Error(
					'[runtime-dynamic] runtime has not started; call await runtime.start() before accessing ctx',
				)
			}
			const controller = readDynamicRuntimeController(server)
			if (!controller)
				throw new Error('[runtime-dynamic] dynamic runtime controller is unavailable')
			return controller.booted.ctx as Context
		},
		start,
		stop: async () => {
			if (stopped) return
			stopped = true
			if (startPromise) await startPromise.catch((): void => undefined)
			await server?.close()
		},
	}
}

function readDynamicRuntimeController(
	server: import('vite').ViteDevServer,
): { booted: { ctx: Context } } | undefined {
	const key = Symbol.for('pluxel.dynamicRuntimeController')
	return (server as unknown as Record<PropertyKey, unknown>)[key] as
		| { booted: { ctx: Context } }
		| undefined
}
