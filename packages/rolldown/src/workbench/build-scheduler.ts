import { resolve } from 'node:path'

type Task<T> = () => Promise<T>

type BuildCohort = {
	applicationRoot: string
	pending: Array<() => void>
	running: number
}

class FederationBuildCoordinator {
	private activeCohort: BuildCohort | undefined
	private readonly waitingCohorts: BuildCohort[] = []

	constructor(private readonly concurrency: number) {}

	run<T>(applicationRoot: string, task: Task<T>): Promise<T> {
		return new Promise<T>((resolveTask, rejectTask) => {
			let cohort!: BuildCohort
			const start = () => {
				void Promise.resolve()
					.then(task)
					.then(resolveTask, rejectTask)
					.finally(() => {
						cohort.running -= 1
						this.drain()
					})
			}
			cohort = this.enqueue(applicationRoot, start)
			this.drain()
		})
	}

	private enqueue(applicationRoot: string, start: () => void): BuildCohort {
		if (
			this.activeCohort?.applicationRoot === applicationRoot &&
			this.waitingCohorts.length === 0
		) {
			this.activeCohort.pending.push(start)
			return this.activeCohort
		}
		const waiting = this.waitingCohorts.at(-1)
		if (waiting?.applicationRoot === applicationRoot) {
			waiting.pending.push(start)
			return waiting
		}
		const cohort = { applicationRoot, pending: [start], running: 0 }
		this.waitingCohorts.push(cohort)
		return cohort
	}

	private drain(): void {
		if (!this.activeCohort) {
			this.activeCohort = this.waitingCohorts.shift()
		}
		const cohort = this.activeCohort
		if (!cohort) return
		while (cohort.running < this.concurrency && cohort.pending.length > 0) {
			cohort.running += 1
			cohort.pending.shift()!()
		}
		if (cohort.running > 0 || cohort.pending.length > 0) return
		this.activeCohort = undefined
		this.drain()
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
const buildCacheTransactionQueue = new KeyedSerialTaskQueue()
const outputTransactionQueue = new KeyedSerialTaskQueue()

export function runWorkbenchFederationBuild<T>(applicationRoot: string, task: Task<T>): Promise<T> {
	return federationBuilds.run(resolve(applicationRoot), task)
}

/** Serializes tools that share one persistent compiler/cache directory. */
export function runWorkbenchBuildCacheTransaction<T>(cacheDir: string, task: Task<T>): Promise<T> {
	return buildCacheTransactionQueue.run(resolve(cacheDir), task)
}

/** Serializes validation and immutable publication for one exact revision directory. */
export function runWorkbenchOutputTransaction<T>(target: string, task: Task<T>): Promise<T> {
	return outputTransactionQueue.run(resolve(target), task)
}
