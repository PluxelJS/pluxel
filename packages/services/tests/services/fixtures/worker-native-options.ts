import {
	resourceLimits,
	threadId,
	threadName,
	workerData,
	type ResourceLimits,
} from 'node:worker_threads'
import type { WorkerTaskHandler } from '@pluxel/services/workers'

export type Input = Readonly<{ envKey: string; writeValue?: string }>
export type Output = Readonly<{
	value: string | undefined
	execArgv: string[]
	argv: string[]
	resourceLimits: ResourceLimits
	workerData: unknown
	threadId: number
	threadName: string | null
}>

const run: WorkerTaskHandler<Input, Output> = ({ envKey, writeValue }) => {
	if (writeValue !== undefined) process.env[envKey] = writeValue
	return {
		value: process.env[envKey],
		execArgv: [...process.execArgv],
		argv: [...process.argv],
		resourceLimits: { ...resourceLimits },
		workerData,
		threadId,
		threadName,
	}
}

export default run
