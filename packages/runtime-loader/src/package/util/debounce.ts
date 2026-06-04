export function createDebouncedTrigger(config: {
	delayMs: number
	run: () => void | Promise<void>
}) {
	let timer: ReturnType<typeof setTimeout> | null = null
	let pending = false

	const trigger = () => {
		pending = true
		if (timer) return
		timer = setTimeout(async () => {
			timer = null
			if (!pending) return
			pending = false
			await config.run()
		}, config.delayMs)
	}

	return { trigger }
}
