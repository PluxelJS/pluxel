import { resolve } from 'node:path'

type Task<T> = () => Promise<T>

class BoundedTaskQueue {
	private active = 0
	private readonly pending: Array<() => void> = []

	constructor(private readonly limit: number) {}

	async run<T>(task: Task<T>): Promise<T> {
		await this.acquire()
		try {
			return await task()
		} finally {
			this.release()
		}
	}

	private acquire(): Promise<void> {
		if (this.active < this.limit) {
			this.active += 1
			return Promise.resolve()
		}
		return new Promise<void>((resolvePending) => {
			this.pending.push(() => {
				this.active += 1
				resolvePending()
			})
		})
	}

	private release(): void {
		this.active -= 1
		this.pending.shift()?.()
	}
}

class KeyedSerialTaskQueue {
	private readonly tails = new Map<string, Promise<void>>()

	run<T>(key: string, task: Task<T>): Promise<T> {
		const previous = this.tails.get(key) ?? Promise.resolve()
		const result = previous.then(task)
		const tail = result.then(
			(): void => undefined,
			(): void => undefined,
		)
		this.tails.set(key, tail)
		void tail.then((): void => {
			if (this.tails.get(key) === tail) this.tails.delete(key)
			return undefined
		})
		return result
	}
}

// The MF Vite plugin has process-local mutable registries. A build slot therefore
// bounds spawned compiler processes; it is not an in-process critical section.
export const WORKBENCH_ISOLATED_BUILD_CONCURRENCY = 2

const isolatedBuildSlots = new BoundedTaskQueue(WORKBENCH_ISOLATED_BUILD_CONCURRENCY)
const outputTransactionQueue = new KeyedSerialTaskQueue()

/** Bounds independent producer compiler processes without globally serializing them. */
export function runWorkbenchIsolatedBuild<T>(task: Task<T>): Promise<T> {
	return isolatedBuildSlots.run(task)
}

/** Serializes validation and immutable publication for one exact revision directory. */
export function runWorkbenchOutputTransaction<T>(target: string, task: Task<T>): Promise<T> {
	return outputTransactionQueue.run(resolve(target), task)
}
