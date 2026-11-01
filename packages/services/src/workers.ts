import { installOwnerViewCapability } from '@pluxel/core/host'
import { defineHostService } from '@pluxel/host'
import { NodeModuleHost } from './node/token'
import { Workers } from './workers/token'
import { WorkerTaskService } from './workers/service'
import type { WorkersConfig } from './workers/declaration'

export { Workers, type WorkerTaskApi } from './workers/token'
export { defineWorkerTask, WorkerTaskError } from './workers/declaration'
export type {
	WorkerTaskDeclaration,
	WorkerTaskHandler,
	WorkerInputPreparation,
	WorkerPreparedRunOptions,
	WorkerRunOptions,
	WorkersConfig,
	WorkerTaskErrorCode,
} from './workers/declaration'

/** Install one shared worker budget. The Node artifact service must be explicitly installed. */
export function workers(config: WorkersConfig = {}) {
	if (!config || typeof config !== 'object' || Array.isArray(config))
		throw new TypeError('workers() requires a configuration object')
	const native = config.worker
	if (native !== undefined) {
		if (!native || typeof native !== 'object' || Array.isArray(native))
			throw new TypeError('workers.worker must be a native thread options object')
		for (const key of ['eval', 'transferList', 'stdin', 'stdout', 'stderr']) {
			if (key in native)
				throw new TypeError(`workers.worker.${key} is owned by the task entry and lifecycle`)
		}
	}
	const worker = native === undefined ? undefined : { ...native }
	if (worker) {
		if (Array.isArray(worker.argv)) worker.argv = [...worker.argv]
		if (Array.isArray(worker.execArgv)) worker.execArgv = [...worker.execArgv]
		if (worker.env && typeof worker.env === 'object' && !Array.isArray(worker.env))
			worker.env = { ...worker.env }
		if (
			worker.resourceLimits &&
			typeof worker.resourceLimits === 'object' &&
			!Array.isArray(worker.resourceLimits)
		)
			worker.resourceLimits = { ...worker.resourceLimits }
		Object.freeze(worker)
	}
	const snapshot = Object.freeze({ ...config, worker })
	return defineHostService({
		name: 'Workers',
		requires: { nodeModules: NodeModuleHost },
		capabilities: [
			installOwnerViewCapability(Workers, {
				property: 'workers',
				createRoot: (ctx) => new WorkerTaskService(ctx, snapshot),
				createView: (backend, owner) => backend.forOwner(owner),
			}),
		],
	})
}
