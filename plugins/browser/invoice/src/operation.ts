export async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	let abort = () => {}
	const stopped = new Promise<never>((_resolve, reject) => {
		abort = () => reject(signal.reason)
		if (signal.aborted) abort()
		else signal.addEventListener('abort', abort, { once: true })
	})
	try {
		return await Promise.race([work, stopped])
	} finally {
		signal.removeEventListener('abort', abort)
	}
}
