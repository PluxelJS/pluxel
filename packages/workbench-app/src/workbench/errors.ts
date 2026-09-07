export function toWorkbenchError(error: unknown, fallback: string): Error {
	if (error instanceof Error) return error
	if (typeof error === 'string') return new Error(error)
	return new Error(fallback, { cause: error })
}
