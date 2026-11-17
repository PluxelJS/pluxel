type FileContent = string | Uint8Array | undefined

/** Observe bytes through the selected backend, including writes outside this process.
 * No replication or conflict resolution. Closing waits for the current read/application.
 * Returning false defers a change while the consumer has an unfinished local transaction.
 */
export function observeFile<T extends FileContent>(
	read: () => Promise<T>,
	initial: T,
	onChange: (content: T) => void | boolean | Promise<void | boolean>,
	onError: (error: unknown) => void,
): () => Promise<void> {
	let previous = initial
	let closed = false
	let reading = false
	let readFailed = false
	let pending: Promise<void> = Promise.resolve()
	const timer = setInterval(() => {
		if (closed || reading) return
		reading = true
		pending = (async () => {
			let content: T
			const recovering = readFailed
			try {
				content = await read()
				readFailed = false
			} catch (error) {
				if (!closed && !readFailed) onError(error)
				readFailed = true
				return
			}
			if (closed || (!recovering && sameFileContent(content, previous))) return
			const before = previous
			previous = content
			try {
				if ((await onChange(content)) === false) previous = before
			} catch (error) {
				if (!closed) onError(error)
			}
		})().finally(() => {
			reading = false
		})
	}, 250)
	if (typeof timer === 'object' && 'unref' in timer) timer.unref()
	return async () => {
		closed = true
		clearInterval(timer)
		await pending
	}
}

function sameFileContent(a: FileContent, b: FileContent): boolean {
	return (
		a === b ||
		(a instanceof Uint8Array &&
			b instanceof Uint8Array &&
			a.length === b.length &&
			a.every((byte, index) => byte === b[index]))
	)
}
