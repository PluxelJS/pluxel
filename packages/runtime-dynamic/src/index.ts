import './register'

import type { Context } from '@pluxel/runtime'
import { defineDynamicRuntimeConfig, type DynamicRuntimeConfig } from './config'

export * from './services'
export { defineDynamicRuntimeConfig }
export type { DynamicRuntimeConfig } from './config'

export type DynamicDevRuntime = {
	readonly ctx: Context
	start(): Promise<void>
	stop(): Promise<void>
}

export async function createDynamicDevRuntime(
	config: DynamicRuntimeConfig,
): Promise<DynamicDevRuntime> {
	const { bootPlannedLoaderHmrHost, planLoaderHmrHostFromConfig } = await import('./hmr/host')
	const plan = await planLoaderHmrHostFromConfig(config)
	let booted: Awaited<ReturnType<typeof bootPlannedLoaderHmrHost>> | undefined
	let startPromise: Promise<void> | undefined
	let stopped = false

	const start = async (): Promise<void> => {
		if (booted) return
		if (stopped) throw new Error('[runtime-dynamic] cannot start a stopped runtime')
		startPromise ??= bootPlannedLoaderHmrHost(plan)
			.then((result) => {
				booted = result
			})
			.catch((error) => {
				startPromise = undefined
				throw error
			})
		await startPromise
	}

	return {
		get ctx() {
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
			await booted?.ctx.effects.dispose()
		},
	}
}

/** @deprecated Use createDynamicDevRuntime(). The current direct dynamic route is the loader dev/HMR host. */
export type DynamicRuntime = DynamicDevRuntime

/** @deprecated Use createDynamicDevRuntime(). The current direct dynamic route is the loader dev/HMR host. */
export const createDynamicRuntime = createDynamicDevRuntime
