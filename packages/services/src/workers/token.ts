import type { WorkerTaskService } from './service'

export type WorkerTaskApi = Pick<WorkerTaskService, 'ctx' | 'run' | 'runPrepared'>
/** Owner-bound access to the Host worker budget. */
export abstract class Workers {}
export interface Workers extends WorkerTaskApi {}
