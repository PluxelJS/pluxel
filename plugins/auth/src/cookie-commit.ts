import { SessionStore } from './sessions.ts'

const MAX_BODY_BYTES = 1_024

function response(status: number, cookie?: string): Response {
	const headers = new Headers({ 'cache-control': 'no-store' })
	if (cookie) headers.set('set-cookie', cookie)
	return new Response(null, { status, headers })
}

function sameOrigin(request: Request): boolean {
	if ((request.headers.get('sec-fetch-site') ?? '').toLowerCase() === 'cross-site') return false
	const origin = request.headers.get('origin')
	if (!origin) return false
	try {
		return origin === new URL(request.url).origin
	} catch {
		return false
	}
}

async function readTicket(request: Request): Promise<string | undefined> {
	if (request.method.toUpperCase() !== 'POST') return undefined
	if (
		request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !==
		'application/json'
	) {
		return undefined
	}
	const declared = Number(request.headers.get('content-length'))
	if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return undefined
	if (!request.body) return undefined
	const reader = request.body.getReader()
	const chunks: Buffer[] = []
	let size = 0
	try {
		while (true) {
			const chunk = await reader.read()
			if (chunk.done) break
			size += chunk.value.byteLength
			if (size > MAX_BODY_BYTES) {
				await reader.cancel('Cookie commit body too large')
				return undefined
			}
			chunks.push(Buffer.from(chunk.value))
		}
	} finally {
		reader.releaseLock()
	}
	try {
		const value = JSON.parse(Buffer.concat(chunks, size).toString('utf8')) as unknown
		if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
		const record = value as Record<string, unknown>
		const keys = Object.keys(record)
		return keys.length === 1 && keys[0] === 'ticket' && typeof record.ticket === 'string'
			? record.ticket
			: undefined
	} catch {
		return undefined
	}
}

export async function handleCookieCommit(
	request: Request,
	context: Readonly<{ local: boolean; secure: boolean }>,
	sessions: SessionStore,
): Promise<Response> {
	if ((!context.secure && !context.local) || !sameOrigin(request)) return response(404)
	const ticket = await readTicket(request)
	const cookie = ticket ? sessions.commit(ticket, context.secure) : undefined
	return cookie ? response(204, cookie) : response(401)
}
