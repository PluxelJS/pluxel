import { resolve } from 'node:path'

type Task<T> = () => Promise<T>

type PendingBuild = Readonly<{
	applicationRoot: string
	start: () => void
}>

class FederationBuildCoordinator {
	private activeRoot: string | undefined
	private active = 0
	private readonly pending: PendingBuild[] = []

	constructor(private readonly concurrency: number) {}

	run<T>(applicationRoot: string, task: Task<T>): Promise<T> {
		return new Promise<T>((resolveTask, rejectTask) => {
			this.pending.push({
				applicationRoot,
				start: () => {
					this.active += 1
					void Promise.resolve()
						.then(task)
						.then(resolveTask, rejectTask)
						.finally(() => {
							this.active -= 1
							this.drain()
						})
				},
			})
			this.drain()
		})
	}

	private drain(): void {
		if (this.activeRoot === undefined) {
			this.activeRoot = this.pending[0]?.applicationRoot
		}
		while (this.activeRoot !== undefined && this.active < this.concurrency) {
			const nextIndex = this.pending.findIndex(
				(item) => item.applicationRoot === this.activeRoot,
			)
			if (nextIndex < 0) break
			this.pending.splice(nextIndex, 1)[0]!.start()
		}
		if (this.active > 0) return
		this.activeRoot = undefined
		if (this.pending.length > 0) this.drain()
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

// MF Vite 1.21.1 isolates producer state, but its package export detector still owns a
// process-global project root. Same-root builds may run concurrently; switching roots waits
// until the active cohort drains so one application cannot inspect another's shared winners.
const federationBuilds = new FederationBuildCoordinator(2)
const outputTransactionQueue = new KeyedSerialTaskQueue()

export function runWorkbenchFederationBuild<T>(
	applicationRoot: string,
	task: Task<T>,
): Promise<T> {
	return federationBuilds.run(resolve(applicationRoot), task)
}

/** Serializes validation and immutable publication for one exact revision directory. */
export function runWorkbenchOutputTransaction<T>(target: string, task: Task<T>): Promise<T> {
	return outputTransactionQueue.run(resolve(target), task)
}
