export type EdenResultLike<T = unknown> = {
	data: T | null
	error: unknown
	response?: Response
}

export type RuntimeTreatyFetchOptions = {
	fetch?: RequestInit
}

export type RuntimeTreatyQueryOptions<TQuery> = RuntimeTreatyFetchOptions & {
	query?: TQuery
}

export type RuntimeTreatyGet<TData, TQuery = never> = {
	get(
		options?: [TQuery] extends [never]
			? RuntimeTreatyFetchOptions
			: RuntimeTreatyQueryOptions<TQuery>,
	): Promise<EdenResultLike<TData>>
}

export async function expectData<T>(promise: Promise<EdenResultLike<T>>): Promise<T> {
	const result = await promise
	const status = result.response?.status
	if (status !== undefined && status >= 400) throw new Error(`HTTP ${status}`)
	if (result.error) {
		if (result.error instanceof Error) throw result.error
		throw new Error(status ? `HTTP ${status}` : 'Request failed')
	}
	if (result.data === null || result.data === undefined) {
		throw new Error(status ? `HTTP ${status}` : 'Empty response')
	}
	return result.data
}
