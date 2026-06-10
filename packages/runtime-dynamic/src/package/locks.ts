export class KeyedLock<T> {
	private readonly locks = new Map<string, Promise<T>>()

	run(key: string, task: () => Promise<T>): Promise<T> {
		const existing = this.locks.get(key)
		if (existing) return existing
		const promise = task().finally(() => {
			this.locks.delete(key)
		})
		this.locks.set(key, promise)
		return promise
	}
}
