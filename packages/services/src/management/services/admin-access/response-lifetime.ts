export type ResponseLease = Readonly<{
	signal: AbortSignal
	dispose(): void
}>

/** Keep an owner invocation alive until the response body settles, and cancel it on withdrawal. */
export function responseWithLease(response: Response, lease: ResponseLease): Response {
	if (!response.body) {
		lease.dispose()
		return response
	}

	const reader = response.body.getReader()
	let released = false
	const release = () => {
		if (released) return
		released = true
		lease.signal.removeEventListener('abort', abort)
		lease.dispose()
	}
	const abort = () => {
		void reader
			.cancel(lease.signal.reason)
			.catch((): undefined => undefined)
			.finally(release)
	}
	lease.signal.addEventListener('abort', abort, { once: true })
	if (lease.signal.aborted) abort()

	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const result = await reader.read()
				if (result.done) {
					release()
					controller.close()
					return
				}
				controller.enqueue(result.value)
			} catch (error) {
				release()
				controller.error(error)
			}
		},
		async cancel(reason) {
			try {
				await reader.cancel(reason)
			} finally {
				release()
			}
		},
	})

	return new Response(body, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	})
}
