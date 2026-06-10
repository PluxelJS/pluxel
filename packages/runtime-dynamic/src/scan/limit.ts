export function createLimiter(concurrency: number) {
	let active = 0
	const queue: Array<() => void> = []

	const next = () => {
		active--
		queue.shift()?.()
	}

	return function run<T>(task: () => Promise<T>): Promise<T> {
		return new Promise((resolve, reject) => {
			const execute = async () => {
				active++
				try {
					resolve(await task())
				} catch (error) {
					reject(error)
				} finally {
					next()
				}
			}

			if (active < concurrency) void execute()
			else queue.push(() => void execute())
		})
	}
}
