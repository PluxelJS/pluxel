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
	const snapshot = Object.freeze({ ...config })
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
