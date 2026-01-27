export class AsyncSerialLock {
	private tail: Promise<void> = Promise.resolve()

	async run<T>(fn: () => Promise<T>): Promise<T> {
		const prev = this.tail
		let release: (() => void) | undefined
		this.tail = new Promise<void>((r) => {
			release = r
		})
		await prev
		try {
			return await fn()
		} finally {
			release?.()
		}
	}
}

