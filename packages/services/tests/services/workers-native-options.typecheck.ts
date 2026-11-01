import { SHARE_ENV, type WorkerOptions } from 'node:worker_threads'
import { workers, type WorkersConfig } from '@pluxel/services/workers'

const native: NonNullable<WorkersConfig['worker']> = {
	argv: ['task-worker', 17],
	env: SHARE_ENV,
	execArgv: ['--no-warnings'],
	name: 'native-worker',
	workerData: new Map([['startup', 17]]),
	resourceLimits: { maxOldGenerationSizeMb: 128, codeRangeSizeMb: 16, stackSizeMb: 4 },
	trackUnmanagedFds: true,
}
workers({ worker: native })
const upstream: WorkerOptions = native
void upstream

// @ts-expect-error Pluxel owns the worker entry interpretation.
workers({ worker: { eval: false } })
// @ts-expect-error Transfer belongs to each admitted task.
workers({ worker: { transferList: [] } })
// @ts-expect-error Worker stdio retains the parent streams under lifecycle ownership.
workers({ worker: { stdin: false } })
// @ts-expect-error Worker stdio retains the parent streams under lifecycle ownership.
workers({ worker: { stdout: false } })
// @ts-expect-error Worker stdio retains the parent streams under lifecycle ownership.
workers({ worker: { stderr: false } })
