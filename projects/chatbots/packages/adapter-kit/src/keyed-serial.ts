/** Serializes mutations for one key while allowing unrelated keys to run concurrently. */
export class KeyedSerialExecutor<Key> {
	private readonly tails = new Map<Key, Promise<void>>()

	run<Value>(key: Key, task: () => Promise<Value>): Promise<Value> {
		const previous = this.tails.get(key) ?? Promise.resolve()
		const current = previous.then(task, task)
		const tail = current.then(
			(): void => undefined,
			(): void => undefined,
		)
		this.tails.set(key, tail)
		void tail.then((): void => {
			if (this.tails.get(key) === tail) this.tails.delete(key)
			return undefined
		})
		return current
	}
}
