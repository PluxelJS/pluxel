import { newHttpBatchRpcResponse } from 'capnweb'
import { and, asc, eq, gt } from 'drizzle-orm'
import { MarketAdmin } from './admin'
import { processNotifications } from './jobs'
import {
	coordinate,
	exactVersion,
	MarketError,
	object,
	packageName,
	readBytes,
	readJson,
	registry,
} from './protocol'
import { notifications, packages, releases } from './schema'
import { connect, enqueue, getRelease, listPackages, receipt } from './store'

export type Env = { DB: D1Database; ADMIN_TOKEN: string }

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

async function json(request: Request, value: unknown) {
	const body = JSON.stringify(value)
	const digest = new Uint8Array(
		await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)),
	)
	const etag = `"${btoa(String.fromCharCode(...digest))}"`
	const headers = {
		ETag: etag,
		'Cache-Control': 'public, max-age=30',
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

function pageInput(url: URL, scope: string) {
	const rawLimit = url.searchParams.get('limit') ?? '20'
	if (!/^[1-9]\d?$/.test(rawLimit) || Number(rawLimit) > 50)
		throw new MarketError('invalid-limit', 'limit must be an integer from 1 to 50')
	const rawCursor = url.searchParams.get('cursor')
	if (!rawCursor) return { limit: Number(rawLimit), after: null }
	let value: unknown
	try {
		if (rawCursor.length > 1024) throw new Error('Oversized cursor')
		value = JSON.parse(atob(rawCursor.replaceAll('-', '+').replaceAll('_', '/'))) as unknown
	} catch {
		throw new MarketError('invalid-cursor', 'Invalid cursor; restart the query')
	}
	if (
		!object(value) ||
		value.scope !== scope ||
		typeof value.after !== 'string' ||
		value.after.length > 214 ||
		Object.keys(value).length !== 2
	) {
		throw new MarketError(
			'invalid-cursor',
			'The cursor belongs to another query; restart the query',
		)
	}
	return { limit: Number(rawLimit), after: value.after }
}

function cursor(scope: string, after: string | null) {
	return after === null
		? null
		: btoa(JSON.stringify({ scope, after }))
				.replaceAll('+', '-')
				.replaceAll('/', '_')
				.replaceAll('=', '')
}

function decoded(value: string) {
	try {
		return decodeURIComponent(value)
	} catch {
		throw new MarketError('invalid-path', 'Invalid URL encoding')
	}
}

async function dispatch(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url)
	const path = url.pathname
	if (path === '/admin') {
		if (request.method !== 'POST') throw new MarketError('method-not-allowed', 'POST required', 405)
		if (!env.ADMIN_TOKEN || request.headers.get('Authorization') !== `Bearer ${env.ADMIN_TOKEN}`) {
			throw new MarketError('unauthorized', 'Administration requires a bearer token', 401)
		}
		const bytes = await readBytes(request.body, 64 * 1024)
		const bounded = new Request(request.url, {
			method: 'POST',
			headers: request.headers,
			body: bytes,
		})
		const response = await newHttpBatchRpcResponse(bounded, new MarketAdmin(env.DB))
		response.headers.set('Cache-Control', 'no-store')
		return response
	}
	if (request.method === 'OPTIONS' && path.startsWith('/v1')) {
		return new Response(null, {
			status: 204,
			headers: {
				'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
				'Access-Control-Allow-Headers': 'Content-Type, If-None-Match',
				'Access-Control-Max-Age': '600',
			},
		})
	}
	if (path === '/v1' && request.method === 'GET') {
		return json(request, {
			protocolVersion: 1,
			registry,
			capabilities: { notifications: true, provenanceVerification: false },
		})
	}
	const db = connect(env.DB)
	if (path === '/v1/notifications' && request.method === 'POST') {
		if (request.headers.get('Content-Type')?.split(';')[0].trim() !== 'application/json')
			throw new MarketError('unsupported-media-type', 'Content-Type must be application/json', 415)
		const input = coordinate(await readJson(request.body, 4096))
		const row = await enqueue(db, input, Date.now())
		return Response.json(receipt(row), {
			status: row.status === 'failed' || row.status === 'indexed' ? 200 : 202,
			headers: { Location: `/v1/notifications/${row.id}`, 'Cache-Control': 'no-store' },
		})
	}
	const taskMatch = /^\/v1\/notifications\/([\w-]{1,64})$/.exec(path)
	if (taskMatch && request.method === 'GET') {
		const row = await db
			.select()
			.from(notifications)
			.where(eq(notifications.id, taskMatch[1]))
			.get()
		if (!row) throw new MarketError('not-found', 'Receipt not found or expired', 404)
		return Response.json(receipt(row), { headers: { 'Cache-Control': 'no-store' } })
	}
	if (path === '/v1/packages' && request.method === 'GET') {
		const query = url.searchParams.get('query') ?? ''
		if (query.length > 100 || /[^\x20-\x7e]/.test(query))
			throw new MarketError(
				'invalid-query',
				'query must contain at most 100 ASCII characters from an npm name',
			)
		const { after, limit } = pageInput(url, query)
		const page = await listPackages(db, query, after, limit)
		return json(request, { ...page, nextCursor: cursor(query, page.nextCursor) })
	}
	const packageMatch = /^\/v1\/packages\/([^/]+)(?:\/releases(?:\/([^/]+))?)?$/.exec(path)
	if (packageMatch && request.method === 'GET') {
		const name = decoded(packageMatch[1])
		if (!packageName(name))
			throw new MarketError('invalid-name', 'Expected an encoded npm package name')
		if (packageMatch[2]) {
			const version = decoded(packageMatch[2])
			if (!exactVersion(version))
				throw new MarketError('invalid-version', 'Expected an exact semver version')
			const release = await getRelease(db, name, version)
			if (!release) throw new MarketError('not-found', 'Release is not indexed or visible', 404)
			return json(request, release)
		}
		const record = await db
			.select()
			.from(packages)
			.where(and(eq(packages.name, name), eq(packages.hidden, false)))
			.get()
		if (!record) throw new MarketError('not-found', 'Package is not indexed or visible', 404)
		if (path.endsWith('/releases')) {
			const { after, limit } = pageInput(url, name)
			const rows = await db
				.select({
					version: releases.version,
					integrity: releases.integrity,
					checkedAt: releases.checkedAt,
				})
				.from(releases)
				.where(
					and(eq(releases.name, name), after === null ? undefined : gt(releases.version, after)),
				)
				.orderBy(asc(releases.version))
				.limit(limit + 1)
			return json(request, {
				releases: rows.slice(0, limit),
				nextCursor: cursor(name, rows.length > limit ? rows[limit - 1].version : null),
				coverage: 'indexed-only',
			})
		}
		return json(request, {
			name,
			description: record.description,
			distTags: record.distTags,
			observedAt: record.observedAt,
			coverage: 'indexed-only',
		})
	}
	throw new MarketError('not-found', 'Resource not found', 404)
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		let response: Response
		try {
			response = await dispatch(request, env)
		} catch (error) {
			if (!(error instanceof MarketError)) throw error
			response = problem(error)
		}
		if (new URL(request.url).pathname.startsWith('/v1')) {
			response.headers.set('Access-Control-Allow-Origin', '*')
			response.headers.set('Access-Control-Expose-Headers', 'ETag, Location, Retry-After')
		}
		return response
	},
	async scheduled(_controller: ScheduledController, env: Env) {
		await processNotifications(connect(env.DB))
	},
} satisfies ExportedHandler<Env>
