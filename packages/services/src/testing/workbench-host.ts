import {
	createServiceInternalTestHost,
	type ServiceTestHost,
	type ServiceTestHostOptions,
} from './service-host'
import { resolvePluginTestTarget } from '@pluxel/core/internal/test'
import type { WorkbenchTestDriver } from '@pluxel/workbench/test'

export type WorkbenchTestHostOptions = Omit<ServiceTestHostOptions, 'management'>
export interface WorkbenchTestHost extends ServiceTestHost {
	readonly workbench: WorkbenchTestDriver
}

/** Creates an isolated service host with Management and a local Workbench test backend. */
export async function createWorkbenchTestHost(
	options: WorkbenchTestHostOptions = {},
): Promise<WorkbenchTestHost> {
	const { createWorkbenchTestDriver } = await import('@pluxel/workbench/internal/test')
	let driver: ReturnType<typeof createWorkbenchTestDriver> | undefined
	const internal = await createServiceInternalTestHost(
		{ ...options, management: true, workbench: true },
		{ beforeClose: () => driver?.dispose() },
	)
	driver = createWorkbenchTestDriver({
		ctx: internal.ctx,
		resolveTarget(target) {
			// Reuse the host's stale-constructor and fork validation before checking publication.
			internal.isRunning(target)
			return resolvePluginTestTarget(target).address
		},
	})
	const dispose = internal.dispose
	return Object.freeze({
		config: internal.config,
		http: internal.http,
		commands: internal.commands,
		start: internal.start,
		stop: internal.stop,
		restart: internal.restart,
		replaceDefinition: internal.replaceDefinition,
		commit: internal.commit,
		commitExpectFail: internal.commitExpectFail,
		require: internal.require,
		isRunning: internal.isRunning,
		workbench: driver.workbench,
		dispose,
		[Symbol.asyncDispose]: dispose,
	})
}
