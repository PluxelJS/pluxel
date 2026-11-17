import { newHttpBatchRpcResponse } from 'capnweb'
import { and, asc, eq, gt, sql } from 'drizzle-orm'
import { MarketAdmin } from './admin'
import { processNotifications } from './jobs'
import {
	coordinate,
	decodeCursor,
	encodeCursor,
	exactVersion,
	MarketError,
	packageName,
	pageLimit,
	readBytes,
	readJson,
	registry,
	registryBase,
	type PackageQuery,
} from './protocol'
import { notifications, packages, releases } from './schema'
import { connect, enqueue, facets, getRelease, listPackages, receipt } from './store'
import { registrySources, sourceFor } from './sources'

export type Env = { DB: D1Database; ADMIN_TOKEN: string; REGISTRIES?: string }

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

async function json(request: Request, value: unknown, authenticated = false) {
	const body = JSON.stringify(value)
	const digest = new Uint8Array(
		await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)),
	)
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

function pageInput(url: URL, scope: string) {
	const rawLimit = url.searchParams.get('limit')
	const limit = pageLimit(rawLimit === null ? undefined : Number(rawLimit))
	const after = decodeCursor(url.searchParams.get('cursor') ?? undefined, scope)
	if (after !== null && (typeof after !== 'string' || after.length > 214))
		throw new MarketError('invalid-cursor', 'Invalid release cursor; restart the query')
	return { limit, after }
}

function cursor(scope: string, after: string | null) {
	return after === null ? null : encodeCursor(scope, after)
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
	const sources = registrySources(env.REGISTRIES)
	const authorization = request.headers.get('Authorization')
	const admin = Boolean(env.ADMIN_TOKEN) && authorization === `Bearer ${env.ADMIN_TOKEN}`
	const visibleSources = sources.filter((source) => admin || source.access === 'public')
	const visibleRegistries = visibleSources.map((source) => source.registry)
	if (path === '/admin') {
		if (request.method !== 'POST') throw new MarketError('method-not-allowed', 'POST required', 405)
		if (!admin) {
			throw new MarketError('unauthorized', 'Administration requires a bearer token', 401)
		}
		const bytes = await readBytes(request.body, 64 * 1024)
		const bounded = new Request(request.url, {
			method: 'POST',
			headers: request.headers,
			body: bytes,
		})
		const response = await newHttpBatchRpcResponse(bounded, new MarketAdmin(env.DB, sources))
		response.headers.set('Cache-Control', 'no-store')
		return response
	}
	if (request.method === 'OPTIONS' && path.startsWith('/v1')) {
		return new Response(null, {
			status: 204,
			headers: {
				'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
				'Access-Control-Allow-Headers': 'Content-Type, If-None-Match, Authorization',
				'Access-Control-Max-Age': '600',
			},
		})
	}
	if (path === '/v1' && request.method === 'GET') {
		return json(
			request,
			{
				protocolVersion: 1,
				registries: visibleSources.map((source) => ({
					registry: source.registry,
					access: source.access,
				})),
				capabilities: {
					notifications: true,
					provenanceVerification: false,
					search: true,
					marketMetadata: true,
				},
			},
			admin,
		)
	}
	const db = connect(env.DB)
	if (path === '/v1/notifications' && request.method === 'POST') {
		if (request.headers.get('Content-Type')?.split(';')[0].trim() !== 'application/json')
			throw new MarketError('unsupported-media-type', 'Content-Type must be application/json', 415)
		const input = coordinate(await readJson(request.body, 4096))
		const source = sourceFor(sources, input.registry)
		if (
			source.access === 'admin' &&
			!admin &&
			(!source.notificationToken || authorization !== `Bearer ${source.notificationToken}`)
		)
			throw new MarketError(
				'unauthorized',
				'Private-source notifications require a notification credential',
				401,
			)
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
		const source = row ? sources.find((item) => item.registry === row.registry) : undefined
		if (
			!row ||
			!source ||
			(source.access === 'admin' &&
				!admin &&
				(!source.notificationToken || authorization !== `Bearer ${source.notificationToken}`))
		)
			throw new MarketError('not-found', 'Receipt not found or expired', 404)
		return Response.json(receipt(row), { headers: { 'Cache-Control': 'no-store' } })
	}
	if (authorization && !admin)
		throw new MarketError(
			'unauthorized',
			'Catalog access requires a valid administrator credential',
			401,
		)
	if (path === '/v1/facets' && request.method === 'GET')
		return json(request, await facets(db, visibleRegistries), admin)
	if (path === '/v1/packages' && request.method === 'GET') {
		const input: PackageQuery = {}
		for (const [key, value] of url.searchParams) {
			if (key === 'limit') input.limit = Number(value)
			else if (key === 'official') {
				if (value !== 'true' && value !== 'false')
					throw new MarketError('invalid-query', 'official must be true or false')
				input.official = value === 'true'
			} else if (['query', 'registry', 'category', 'tag', 'cursor'].includes(key))
				Object.assign(input, { [key]: value })
			else throw new MarketError('invalid-query', `Unsupported query field: ${key}`)
		}
		if (input.registry !== undefined) input.registry = registryBase(input.registry)
		return json(request, await listPackages(db, input, visibleRegistries), admin)
	}
	const packageMatch = /^\/v1\/packages\/([^/]+)(?:\/releases(?:\/([^/]+))?)?$/.exec(path)
	if (packageMatch && request.method === 'GET') {
		const name = decoded(packageMatch[1])
		if (!packageName(name))
			throw new MarketError('invalid-name', 'Expected an encoded npm package name')
		const selectedRegistry = registryBase(url.searchParams.get('registry') ?? registry)
		if (!visibleRegistries.includes(selectedRegistry))
			throw new MarketError('not-found', 'Package is not indexed or visible', 404)
		if (packageMatch[2]) {
			const version = decoded(packageMatch[2])
			if (!exactVersion(version))
				throw new MarketError('invalid-version', 'Expected an exact semver version')
			const release = await getRelease(db, { registry: selectedRegistry, name, version })
			if (!release) throw new MarketError('not-found', 'Release is not indexed or visible', 404)
			return json(request, release, admin)
		}
		const record = await db
			.select()
			.from(packages)
			.where(
				and(
					eq(packages.registry, selectedRegistry),
					eq(packages.name, name),
					eq(packages.hidden, false),
				),
			)
			.get()
		if (!record) throw new MarketError('not-found', 'Package is not indexed or visible', 404)
		if (path.endsWith('/releases')) {
			const scope = JSON.stringify([selectedRegistry, name])
			const { after, limit } = pageInput(url, scope)
			const rows = await db
				.select({
					version: releases.version,
					integrity: releases.integrity,
					checkedAt: releases.checkedAt,
				})
				.from(releases)
				.where(
					and(
						eq(releases.registry, selectedRegistry),
						eq(releases.name, name),
						after === null ? undefined : gt(releases.version, after),
					),
				)
				.orderBy(asc(releases.version))
				.limit(limit + 1)
			return json(
				request,
				{
					releases: rows.slice(0, limit),
					nextCursor: cursor(scope, rows.length > limit ? rows[limit - 1].version : null),
					coverage: 'indexed-only',
				},
				admin,
			)
		}
		const indexed = await db
			.select({ count: sql<number>`count(*)` })
			.from(releases)
			.where(and(eq(releases.registry, selectedRegistry), eq(releases.name, name)))
			.get()
		return json(
			request,
			{
				registry: selectedRegistry,
				name,
				description: record.description,
				distTags: record.distTags,
				observedAt: record.observedAt,
				repository: record.repository,
				repositoryStars: record.repositoryStars,
				repositoryObservedAt: record.repositoryObservedAt,
				metadataVersion: record.metadataVersion,
				readme: record.readme,
				license: record.license,
				latest: record.distTags.latest ?? null,
				indexedVersions: indexed!.count,
				official: record.official,
				category: record.category,
				tags: record.tags,
				coverage: 'indexed-only',
			},
			admin,
		)
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
