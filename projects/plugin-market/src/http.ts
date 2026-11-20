import { MarketError } from './protocol'

function problem(error: MarketError): Response {
	return Response.json(
		{
			type: `urn:pluxel:market:${error.code}`,
			title: error.message,
			status: error.status,
			code: error.code,
		},
		{
			status: error.status,
			headers: {
				'Content-Type': 'application/problem+json',
				'Cache-Control': 'no-store',
				...(error.status === 429 ? { 'Retry-After': '60' } : {}),
			},
		},
	)
}

export async function json(
	request: Request,
	value: unknown,
	{
		authenticated = false,
		snapshotByteLimit,
	}: { authenticated?: boolean; snapshotByteLimit?: number } = {},
): Promise<Response> {
	const body = new TextEncoder().encode(JSON.stringify(value))
	if (snapshotByteLimit !== undefined && body.byteLength > snapshotByteLimit)
		throw new MarketError(
			'snapshot-too-large',
			'The public catalog exceeds the snapshot size limit',
			503,
		)
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', body))
	const etag = `"${btoa(String.fromCharCode(...digest))}"`
	const headers = {
		ETag: etag,
		'Cache-Control': authenticated ? 'no-store' : 'public, max-age=30',
		Vary: 'Authorization',
		'Content-Type': 'application/json',
	}
	const conditions = request.headers
		.get('If-None-Match')
		?.split(',')
		.map((entry) => entry.trim().replace(/^W\//, ''))
	return conditions?.some((entry) => entry === '*' || entry === etag)
		? new Response(null, { status: 304, headers })
		: new Response(body, { headers })
}

export async function marketResponse(
	request: Request,
	respond: () => Response | Promise<Response>,
	methods = 'GET, POST, OPTIONS',
): Promise<Response> {
	const api = new URL(request.url).pathname.startsWith('/v1')
	let response: Response
	if (api && request.method === 'OPTIONS') {
		response = new Response(null, {
			status: 204,
			headers: {
				'Access-Control-Allow-Methods': methods,
				'Access-Control-Allow-Headers': 'Content-Type, If-None-Match, Authorization',
				'Access-Control-Max-Age': '600',
			},
		})
	} else {
		try {
			response = await respond()
		} catch (error) {
			if (!(error instanceof MarketError)) throw error
			response = problem(error)
		}
	}
	if (api) {
		response.headers.set('Access-Control-Allow-Origin', '*')
		response.headers.set('Access-Control-Expose-Headers', 'ETag, Location, Retry-After')
	}
	return response
}
