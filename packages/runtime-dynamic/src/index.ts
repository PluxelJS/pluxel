import type { Context } from '@pluxel/runtime'
import {
	assertDynamicRuntimeConfig,
	defineDynamicRuntimeConfig,
	type DynamicRuntimeConfig,
} from './config'

export { defineDynamicRuntimeConfig }
export type { DynamicRuntimeConfig, DynamicRuntimeStorageOptions } from './config'
export type { BuiltinDistPluginSpec, BuiltinForkSpec, BuiltinPluginSpec } from './builtin-spec'
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
	config: DynamicRuntimeConfig,
): Promise<DynamicDevRuntime> {
	assertDynamicRuntimeConfig(config)
	const { bootPlannedLoaderHmrHost, planLoaderHmrHostFromConfig } = await import('./hmr/host')
	const plan = await planLoaderHmrHostFromConfig(config)
	let booted: Awaited<ReturnType<typeof bootPlannedLoaderHmrHost>> | undefined
	let startPromise: Promise<void> | undefined
	let stopped = false

	const start = async (): Promise<void> => {
		if (stopped) throw new Error('[runtime-dynamic] cannot start a stopped runtime')
		if (booted) return
		startPromise ??= bootPlannedLoaderHmrHost(plan)
			.then(async (result) => {
				try {
					await result.hmr.start()
					booted = result
					return undefined
				} catch (error) {
					await result.stop()
					throw error
				}
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
			if (!booted) {
				throw new Error(
					'[runtime-dynamic] runtime has not started; call await runtime.start() before accessing ctx',
				)
			}
			return booted.ctx as Context
		},
		start,
		stop: async () => {
			if (stopped) return
			stopped = true
			if (startPromise) await startPromise.catch((): void => undefined)
			await booted?.stop()
		},
	}
}
