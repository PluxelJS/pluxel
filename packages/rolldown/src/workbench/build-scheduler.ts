import { resolve } from 'node:path'

type Task = () => Promise<void>

class SerialTaskQueue {
	private tail: Promise<void> = Promise.resolve()

	run(task: Task): Promise<void> {
		const result = this.tail.then(task)
		this.tail = result.then(
			(): void => undefined,
			(): void => undefined,
		)
		return result
	}
}

class KeyedSerialTaskQueue {
	private readonly tails = new Map<string, Promise<void>>()

	run(key: string, task: Task): Promise<void> {
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

const federationBuildQueue = new SerialTaskQueue()
const outputTransactionQueue = new KeyedSerialTaskQueue()

/**
 * @module-federation/vite is not reentrant: its normalized config and virtual-module
 * registries are module-scoped through at least 1.16.16. Keep every in-process
 * Federation builder invocation inside this critical section. See engineering/HMR.md.
 */
export function runWorkbenchFederationBuild(task: Task): Promise<void> {
	return federationBuildQueue.run(task)
}

/** Serializes build, validation, and atomic publication for one artifact target. */
export function runWorkbenchOutputTransaction(target: string, task: Task): Promise<void> {
	return outputTransactionQueue.run(resolve(target), task)
}
