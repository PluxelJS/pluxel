// file: src/callbacks.ts
export function onStart(_taskName: string) {
	// transition callback example
	// console.log("start:", taskName);
}

export function onEnterRunning(info: { signal?: AbortSignal }) {
	const { signal } = info

	if (!signal) return

	const timer = setInterval(() => {
		// do periodic work
	}, 10)

	signal.addEventListener('abort', () => clearInterval(timer), { once: true })
}
