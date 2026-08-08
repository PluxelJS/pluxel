export function safeErrorType(error: unknown): string {
	try {
		if (error && typeof error === 'object') {
			const name = (error as { name?: unknown }).name
			if (typeof name === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(name)) return name
		}
	} catch {
		return 'unknown'
	}
	return error === null ? 'null' : typeof error
}
