import { defineContextCapability } from '@pluxel/core/host'
import type { WorkerTaskService } from './service'

export type WorkerTaskApi = Pick<WorkerTaskService, 'ctx' | 'run' | 'runPrepared'>
export const Workers = defineContextCapability<WorkerTaskApi>('services.workers', {
	access: 'all',
	property: 'workers',
})

declare module '@pluxel/core' {
	interface ContextServices {
		readonly workers: WorkerTaskApi
	}
}
