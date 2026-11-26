import { and, asc, eq, gt, inArray, isNotNull, or, sql } from 'drizzle-orm'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core'
import {
	MarketError,
	catalogAuthorId,
	decodeCursor,
	encodeCursor,
	object,
	packageName,
	pageLimit,
	registryBase,
	repositoryAuthor,
	repositoryOwnerIdPrefix,
	taxonomySlug,
	type CatalogFacets,
	type CatalogFilters,
	type Coordinate,
	type PackageIdentity,
	type PackagePage,
	type PackageQuery,
	type Release,
} from '../protocol'
import { packages, releases } from '../db/schema'

export type CatalogDatabase = Pick<BaseSQLiteDatabase<'async', unknown>, 'select'> &
	Pick<DrizzleD1Database, 'batch'>

const filterFields = new Set(['query', 'registry', 'official', 'category', 'tag', 'author'])

function oneValue(params: URLSearchParams, name: string): string | undefined {
	const values = params.getAll(name)
	if (values.length > 1) throw new MarketError('invalid-query', `${name} accepts one value`)
	return values[0]
}

function filterSet(
	params: URLSearchParams,
	name: string,
	valid: (value: string) => boolean,
	normalize?: (value: string) => string,
): string[] | undefined {
	const values = params.getAll(name)
	if (values.length === 0) return undefined
	if (values.length > 20 || !values.every(valid))
		throw new MarketError('invalid-query', `Use up to 20 valid ${name} values`)
	return [...new Set(normalize ? values.map(normalize) : values)].sort()
}

export function catalogQuery(params: URLSearchParams, paged: boolean): PackageQuery {
	for (const key of params.keys()) {
		if (!filterFields.has(key) && !(paged && (key === 'cursor' || key === 'limit')))
			throw new MarketError('invalid-query', `Unsupported query field: ${key}`)
	}
	const query = oneValue(params, 'query')
	if (query !== undefined && query.length > 100)
		throw new MarketError('invalid-query', 'query must contain at most 100 characters')
	const official = oneValue(params, 'official')
	if (official !== undefined && official !== 'true' && official !== 'false')
		throw new MarketError('invalid-query', 'official must be true or false')
	const limit = oneValue(params, 'limit')
	return {
		query,
		registries: filterSet(params, 'registry', (value) => value.length <= 2048, registryBase),
		official: official === undefined ? undefined : official === 'true',
		categories: filterSet(params, 'category', taxonomySlug),
		tags: filterSet(params, 'tag', taxonomySlug),
		authors: filterSet(params, 'author', catalogAuthorId),
		cursor: oneValue(params, 'cursor'),
		limit: limit === undefined ? undefined : Number(limit),
	}
}

const ownerLogin = sql<string>`lower(${packages.repositoryOwner})`

function withRepositoryAuthor<
	T extends { repositoryOwner: string | null; repositoryAvatarUrl: string | null },
>({ repositoryOwner, repositoryAvatarUrl, ...pkg }: T) {
	return {
		...pkg,
		author: repositoryOwner ? repositoryAuthor(repositoryOwner, repositoryAvatarUrl) : null,
	}
}

const packageFields = {
	registry: packages.registry,
	name: packages.name,
	description: packages.description,
	repository: packages.repository,
	repositoryStars: packages.repositoryStars,
	repositoryObservedAt: packages.repositoryObservedAt,
	observedAt: packages.observedAt,
	official: packages.official,
	category: packages.category,
	tags: packages.tags,
}

const summaryFields = {
	...packageFields,
	latest: sql<string | null>`json_extract(${packages.distTags}, '$.latest')`,
	repositoryOwner: packages.repositoryOwner,
	repositoryAvatarUrl: packages.repositoryAvatarUrl,
	indexedVersions: sql<number>`(select count(*) from releases indexed_release where indexed_release.registry = packages.registry and indexed_release.name = packages.name)`,
}

export const packageDetailFields = {
	...packageFields,
	metadataVersion: packages.metadataVersion,
	readme: packages.readme,
	license: packages.license,
	distTags: packages.distTags,
}

export const releasePackage = and(
	eq(packages.registry, releases.registry),
	eq(packages.name, releases.name),
)

export const releaseFields = {
	registry: releases.registry,
	name: releases.name,
	version: releases.version,
	tarball: releases.tarball,
	integrity: releases.integrity,
	checkedAt: releases.checkedAt,
	provenance: releases.provenance,
	peerDependencies: releases.peerDependencies,
	pluginPackages: releases.pluginPackages,
	readme: releases.readme,
	license: releases.license,
}

export function visiblePackages(registries: readonly string[]) {
	return and(eq(packages.hidden, false), inArray(packages.registry, registries))
}

function catalogWhere(input: CatalogFilters, visibleRegistries: readonly string[]) {
	const query = input.query ?? ''
	// Each term is quoted data, never an FTS operator supplied by a requester.
	const terms = query.match(/[\p{L}\p{N}]+/gu) ?? []
	const match = terms.map((term) => `"${term}"*`).join(' AND ')
	const dimensions = {
		registries: input.registries?.length ? inArray(packages.registry, input.registries) : undefined,
		categories: input.categories?.length ? inArray(packages.category, input.categories) : undefined,
		tags: input.tags?.length
			? sql`exists (select 1 from json_each(${packages.tags}) tag where tag.value in (select value from json_each(${JSON.stringify(input.tags)})))`
			: undefined,
		authors: input.authors?.length
			? inArray(
					ownerLogin,
					input.authors.map((id) => id.slice(repositoryOwnerIdPrefix.length)),
				)
			: undefined,
	}
	return (except?: keyof typeof dimensions) =>
		and(
			visiblePackages(visibleRegistries),
			input.official === undefined ? undefined : eq(packages.official, input.official),
			query
				? match
					? sql`${packages}.rowid in (select rowid from package_search where package_search match ${match})`
					: sql`0`
				: undefined,
			...Object.entries(dimensions)
				.filter(([key]) => key !== except)
				.map(([, condition]) => condition),
		)
}

export async function listPackages(
	db: CatalogDatabase,
	input: PackageQuery,
	visibleRegistries: readonly string[],
): Promise<PackagePage> {
	const { limit: requestedLimit, cursor, ...filters } = input
	const limit = pageLimit(requestedLimit)
	const registries = [...visibleRegistries].sort()
	// Bind the cursor to the complete request without making its length grow with the filters.
	const signature = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(JSON.stringify([registries, filters])),
	)
	const scope = btoa(String.fromCharCode(...new Uint8Array(signature)))
	const after = decodeCursor(cursor, scope)
	let beyondCursor
	if (after !== null) {
		if (
			!object(after) ||
			!packageName(after.name) ||
			typeof after.source !== 'number' ||
			!Number.isInteger(after.source) ||
			!registries[after.source] ||
			Object.keys(after).length !== 2
		)
			throw new MarketError('invalid-cursor', 'Invalid package cursor; restart the query')
		beyondCursor = or(
			gt(packages.name, after.name),
			and(eq(packages.name, after.name), gt(packages.registry, registries[after.source])),
		)
	}
	if (registries.length === 0) return { packages: [], nextCursor: null }
	const where = catalogWhere(filters, registries)
	const rows = await db
		.select(summaryFields)
		.from(packages)
		.where(and(where(), beyondCursor))
		.orderBy(asc(packages.name), asc(packages.registry))
		.limit(limit + 1)
	const selected = rows.slice(0, limit)
	const last = selected.at(-1)
	return {
		packages: selected.map(withRepositoryAuthor),
		nextCursor:
			last && rows.length > limit
				? encodeCursor(scope, { name: last.name, source: registries.indexOf(last.registry) })
				: null,
	}
}

export async function facets(
	db: CatalogDatabase,
	input: CatalogFilters,
	visibleRegistries: readonly string[],
): Promise<CatalogFacets> {
	const where = catalogWhere(input, visibleRegistries)
	const count = sql<number>`count(*)`
	const [totals, registries, categories, tags, knownAuthors] = await db.batch([
		db.select({ count }).from(packages).where(where()),
		db
			.select({ value: packages.registry, count })
			.from(packages)
			.where(where('registries'))
			.groupBy(packages.registry)
			.orderBy(asc(packages.registry)),
		db
			.select({ value: sql<string>`${packages.category}`, count })
			.from(packages)
			.where(and(where('categories'), sql`${packages.category} is not null`))
			.groupBy(packages.category)
			.orderBy(asc(packages.category)),
		db
			.select({ value: sql<string>`tag.value`, count })
			.from(packages)
			.innerJoin(sql`json_each(${packages.tags}) tag`, sql`true`)
			.where(where('tags'))
			.groupBy(sql`tag.value`)
			.orderBy(sql`tag.value`),
		db
			.select({
				// A single visible spelling is sufficient when the same owner uses different casing.
				owner: sql<string>`min(${packages.repositoryOwner})`,
				avatarUrl: sql<string | null>`max(${packages.repositoryAvatarUrl})`,
				count,
			})
			.from(packages)
			.where(and(where('authors'), isNotNull(packages.repositoryOwner)))
			.groupBy(ownerLogin)
			.orderBy(asc(ownerLogin)),
	])
	return {
		total: totals[0].count,
		registries,
		categories,
		tags,
		authors: knownAuthors.map((row) =>
			Object.assign(repositoryAuthor(row.owner, row.avatarUrl), { count: row.count }),
		),
	}
}

export async function getPackage(db: CatalogDatabase, input: PackageIdentity) {
	const row = await db
		.select({
			...packageDetailFields,
			...summaryFields,
			checkedRequirements: {
				version: releases.version,
				peerDependencies: releases.peerDependencies,
				pluginPackages: releases.pluginPackages,
			},
		})
		.from(packages)
		.leftJoin(releases, and(releasePackage, eq(releases.version, packages.metadataVersion)))
		.where(
			and(
				eq(packages.registry, input.registry),
				eq(packages.name, input.name),
				eq(packages.hidden, false),
			),
		)
		.get()
	if (!row) return undefined
	const { checkedRequirements, ...pkg } = row
	return { ...withRepositoryAuthor(pkg), ...(checkedRequirements && { checkedRequirements }) }
}

export async function getRelease(
	db: CatalogDatabase,
	input: Coordinate,
	includeHidden = false,
): Promise<Release | null> {
	const row = await db
		.select(releaseFields)
		.from(releases)
		.innerJoin(packages, releasePackage)
		.where(
			and(
				eq(releases.registry, input.registry),
				eq(releases.name, input.name),
				eq(releases.version, input.version),
				includeHidden ? undefined : eq(packages.hidden, false),
			),
		)
		.get()
	return row ?? null
}
