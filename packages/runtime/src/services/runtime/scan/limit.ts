export function createLimiter(concurrency: number) {
	let active = 0
	const queue: Array<() => void> = []

	const next = () => {
		active--
		queue.shift()?.()
	}

	return function run<T>(task: () => Promise<T>): Promise<T> {
		return new Promise((resolve, reject) => {
			const execute = () => {
				active++
				task().then(
					(value) => {
						resolve(value)
						next()
					},
					(error) => {
						reject(error)
						next()
					},
				)
			}

			if (active < concurrency) execute()
			else queue.push(execute)
		})
	}
}
