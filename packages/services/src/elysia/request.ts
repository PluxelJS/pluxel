/** Build a Fetch request view without requiring carrier requests to have native Request internals. */
export function requestWithSignal(request: Request, signal: AbortSignal): Request {
	const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
	return new Request(request.url, {
		method: request.method,
		headers: request.headers,
		signal,
		body: hasBody ? request.body : undefined,
		...(hasBody && request.body ? { duplex: 'half' } : {}),
	} as RequestInit)
}
