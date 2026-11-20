import { and, asc, eq, gt } from 'drizzle-orm'
import {
	catalogQuery,
	facets,
	getPackage,
	getRelease,
	listPackages,
	type CatalogDatabase,
} from './catalog'
import { json } from './http'
import {
	decodeCursor,
	encodeCursor,
	exactVersion,
	MarketError,
	packageName,
	pageLimit,
	registry,
	registryBase,
} from './protocol'
import { packages, releases } from './schema'
import type { RegistrySource } from './sources'

function decoded(value: string) {
	try {
		return decodeURIComponent(value)
	} catch {
		throw new MarketError('invalid-path', 'Invalid URL encoding')
	}
}

function packageNotFound() {
	return new MarketError('not-found', 'Package is not indexed or visible', 404)
}

export async function readCatalog(
	request: Request,
	db: CatalogDatabase,
	sources: readonly Pick<RegistrySource, 'registry' | 'access'>[],
	{ authenticated = false, notifications = false } = {},
): Promise<Response> {
	const url = new URL(request.url)
	const path = url.pathname
	const respond = (value: unknown) => json(request, value, { authenticated })
	if (path === '/v1' && request.method === 'GET') {
		return respond({
			protocolVersion: 1,
			registries: sources.map((source) => ({ registry: source.registry, access: source.access })),
			capabilities: {
				notifications,
				provenanceVerification: false,
				search: true,
				marketMetadata: true,
			},
		})
	}
	if (request.headers.get('Authorization') && !authenticated)
		throw new MarketError(
			'unauthorized',
			'Catalog access requires a valid administrator credential',
			401,
		)
	if (request.method !== 'GET') throw new MarketError('not-found', 'Resource not found', 404)
	const visibleRegistries = sources.map((source) => source.registry)
	if (path === '/v1/facets')
		return respond(await facets(db, catalogQuery(url.searchParams, false), visibleRegistries))
	if (path === '/v1/packages')
		return respond(await listPackages(db, catalogQuery(url.searchParams, true), visibleRegistries))

	const match = /^\/v1\/packages\/([^/]+)(?:\/releases(?:\/([^/]+))?)?$/.exec(path)
	if (!match) throw new MarketError('not-found', 'Resource not found', 404)
	const name = decoded(match[1])
	if (!packageName(name))
		throw new MarketError('invalid-name', 'Expected an encoded npm package name')
	const selectedRegistry = registryBase(url.searchParams.get('registry') ?? registry)
	if (!visibleRegistries.includes(selectedRegistry)) throw packageNotFound()
	const identity = { registry: selectedRegistry, name }
	if (match[2]) {
		const version = decoded(match[2])
		if (!exactVersion(version))
			throw new MarketError('invalid-version', 'Expected an exact semver version')
		const release = await getRelease(db, { ...identity, version })
		if (!release) throw new MarketError('not-found', 'Release is not indexed or visible', 404)
		return respond(release)
	}
	if (!path.endsWith('/releases')) {
		const detail = await getPackage(db, identity)
		if (!detail) throw packageNotFound()
		return respond({ ...detail, coverage: 'indexed-only' })
	}

	const exists = await db
		.select({ name: packages.name })
		.from(packages)
		.where(
			and(
				eq(packages.registry, selectedRegistry),
				eq(packages.name, name),
				eq(packages.hidden, false),
			),
		)
		.get()
	if (!exists) throw packageNotFound()
	const rawLimit = url.searchParams.get('limit')
	const limit = pageLimit(rawLimit === null ? undefined : Number(rawLimit))
	const scope = JSON.stringify([selectedRegistry, name])
	const after = decodeCursor(url.searchParams.get('cursor') ?? undefined, scope)
	if (after !== null && (typeof after !== 'string' || after.length > 214))
		throw new MarketError('invalid-cursor', 'Invalid release cursor; restart the query')
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
	return respond({
		releases: rows.slice(0, limit),
		nextCursor: rows.length > limit ? encodeCursor(scope, rows[limit - 1].version) : null,
		coverage: 'indexed-only',
	})
}
