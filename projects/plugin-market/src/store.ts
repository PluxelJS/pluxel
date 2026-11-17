import { and, asc, desc, eq, gt, gte, inArray, lt, lte, ne, notExists, or, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { audits, notifications, packages, releases } from './schema'
import {
	MarketError,
	decodeCursor,
	encodeCursor,
	object,
	packageName,
	pageLimit,
	taxonomySlug,
	type Coordinate,
	type MarketMetadata,
	type NotificationDetail,
	type NotificationQuery,
	type PackageIdentity,
	type PackagePage,
	type PackageQuery,
	type Receipt,
	type Release,
} from './protocol'

export const maxAttempts = 3
const leaseMs = 60_000
const retentionMs = 7 * 24 * 60 * 60_000

export function connect(binding: D1Database) {
	return drizzle(binding)
}

export type Database = ReturnType<typeof connect>
export type Notification = typeof notifications.$inferSelect

export function receipt(row: Notification): Receipt {
	return {
		id: row.id,
		registry: row.registry,
		name: row.name,
		version: row.version,
		status: row.status,
		attempts: row.attempts,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		nextAttemptAt: row.nextAttemptAt,
		code: row.code,
	}
}

function retryState(row: Notification): NotificationDetail['retry'] {
	if (row.code === 'provenance-runtime-unsupported') return 'provenance-runtime-unsupported'
	if (row.status !== 'failed') return 'not-failed'
	return row.attempts >= maxAttempts ? 'attempts-exhausted' : 'available'
}

export function notificationDetail(row: Notification): NotificationDetail {
	return { ...receipt(row), diagnostic: row.diagnostic, retry: retryState(row) }
}

export async function enqueue(db: Database, input: Coordinate, now: number): Promise<Notification> {
	const key = and(
		eq(notifications.registry, input.registry),
		eq(notifications.name, input.name),
		eq(notifications.version, input.version),
	)
	const existing = await db.select().from(notifications).where(key).get()
	if (existing) return existing
	// Admission limits belong in the INSERT: concurrent requests cannot all pass a prior COUNT.
	const admitted = and(
		sql`(select count(*) from ${notifications}) < 5000`,
		sql`(select count(*) from ${notifications} where ${notifications.createdAt} >= ${now - 60_000}) < 100`,
		sql`(select count(*) from ${notifications} where ${notifications.registry} = ${input.registry} and ${notifications.name} = ${input.name}
			and ${notifications.status} in ('pending', 'processing')) < 10`,
	)
	const rows = await db
		.insert(notifications)
		.select(
			db
				.select({
					id: sql<string>`${crypto.randomUUID()}`.as('id'),
					registry: sql<string>`${input.registry}`.as('registry'),
					name: sql<string>`${input.name}`.as('name'),
					version: sql<string>`${input.version}`.as('version'),
					status: sql<'pending'>`'pending'`.as('status'),
					attempts: sql<number>`0`.as('attempts'),
					createdAt: sql<number>`${now}`.as('created_at'),
					updatedAt: sql<number>`${now}`.as('updated_at'),
					nextAttemptAt: sql<number>`${now}`.as('next_attempt_at'),
					leaseToken: sql<null>`null`.as('lease_token'),
					leaseUntil: sql<null>`null`.as('lease_until'),
					code: sql<null>`null`.as('code'),
					diagnostic: sql<null>`null`.as('diagnostic'),
				})
				.from(sql`(select 1)`)
				.where(admitted),
		)
		.onConflictDoNothing()
		.returning()
	if (rows[0]) return rows[0]
	const duplicate = await db.select().from(notifications).where(key).get()
	if (duplicate) return duplicate
	throw new MarketError(
		'notification-capacity',
		'Notification capacity reached; retry later',
		429,
		true,
	)
}

export async function claim(db: Database, id: string, now: number) {
	const rows = await db
		.update(notifications)
		.set({
			status: 'processing',
			attempts: sql`${notifications.attempts} + 1`,
			updatedAt: now,
			leaseToken: crypto.randomUUID(),
			leaseUntil: now + leaseMs,
			nextAttemptAt: null,
		})
		.where(
			and(
				eq(notifications.id, id),
				lt(notifications.attempts, maxAttempts),
				or(
					and(eq(notifications.status, 'pending'), lte(notifications.nextAttemptAt, now)),
					and(eq(notifications.status, 'processing'), lte(notifications.leaseUntil, now)),
				),
			),
		)
		.returning()
	return rows[0] ?? null
}

export async function failAttempt(
	db: Database,
	task: Notification,
	error: MarketError,
	now: number,
) {
	const retry = error.retryable && task.attempts < maxAttempts
	const rows = await db
		.update(notifications)
		.set({
			status: retry ? 'pending' : 'failed',
			updatedAt: now,
			nextAttemptAt: retry ? now + 60_000 * 2 ** (task.attempts - 1) : null,
			code: error.code,
			diagnostic: error.message.slice(0, 1000),
			leaseToken: null,
			leaseUntil: null,
		})
		.where(
			and(
				eq(notifications.id, task.id),
				eq(notifications.status, 'processing'),
				eq(notifications.leaseToken, task.leaseToken!),
				gt(notifications.leaseUntil, now),
			),
		)
		.returning({ id: notifications.id })
	return rows.length === 1
}

export async function retryNotification(db: Database, id: string, now: number) {
	const row = await db.select().from(notifications).where(eq(notifications.id, id)).get()
	if (!row) return { status: 'not-found' as const }
	const retry = retryState(row)
	if (retry === 'provenance-runtime-unsupported')
		return { status: 'unavailable' as const, code: row.code }
	if (retry !== 'available') return { status: 'not-retryable' as const, receipt: receipt(row) }
	const changed = await db
		.update(notifications)
		.set({
			status: 'pending',
			updatedAt: now,
			nextAttemptAt: now,
		})
		.where(
			and(
				eq(notifications.id, id),
				eq(notifications.status, 'failed'),
				eq(notifications.attempts, row.attempts),
			),
		)
		.returning()
	return changed[0]
		? { status: 'queued' as const, receipt: receipt(changed[0]) }
		: { status: 'conflict' as const }
}

export async function pendingNotifications(db: Database, now: number) {
	await db
		.update(notifications)
		.set({
			status: 'failed',
			code: 'attempts-exhausted',
			diagnostic: 'The final processing lease expired',
			updatedAt: now,
			leaseToken: null,
			leaseUntil: null,
		})
		.where(
			and(
				eq(notifications.status, 'processing'),
				lte(notifications.leaseUntil, now),
				gte(notifications.attempts, maxAttempts),
			),
		)
	return db
		.select()
		.from(notifications)
		.where(
			or(
				and(eq(notifications.status, 'pending'), lte(notifications.nextAttemptAt, now)),
				and(eq(notifications.status, 'processing'), lte(notifications.leaseUntil, now)),
			),
		)
		.orderBy(asc(notifications.createdAt), asc(notifications.id))
		.limit(10)
}

export async function cleanReceipts(db: Database, now: number) {
	const expired = await db
		.select({ id: notifications.id })
		.from(notifications)
		.where(
			and(
				inArray(notifications.status, ['indexed', 'failed']),
				lt(notifications.updatedAt, now - retentionMs),
			),
		)
		.orderBy(asc(notifications.updatedAt))
		.limit(100)
	if (expired.length > 0)
		await db.delete(notifications).where(
			inArray(
				notifications.id,
				expired.map((row) => row.id),
			),
		)
}

export type Observation = {
	description: string | null
	repository: string | null
	metadataVersion: string | null
	readme: Release['readme']
	license: string | null
	distTags: Record<string, string>
	observedAt: number
}

export async function commitRelease(db: Database, release: Release, observation: Observation) {
	const noConflict = notExists(
		db
			.select({ one: sql`1` })
			.from(releases)
			.where(
				and(
					eq(releases.registry, release.registry),
					eq(releases.name, release.name),
					eq(releases.version, release.version),
					ne(releases.integrity, release.integrity),
				),
			),
	)
	// All three writes share the conflict condition inside one D1 transaction.
	// A no-op release insertion must not allow an unrelated observation/audit write.
	await db.batch([
		db
			.insert(packages)
			.select(
				db
					.select({
						registry: sql<string>`${release.registry}`.as('registry'),
						name: sql<string>`${release.name}`.as('name'),
						description: sql<string | null>`${observation.description}`.as('description'),
						repository: sql<string | null>`${observation.repository}`.as('repository'),
						repositoryStars: sql<null>`null`.as('repository_stars'),
						repositoryObservedAt: sql<null>`null`.as('repository_observed_at'),
						metadataVersion: sql<string | null>`${observation.metadataVersion}`.as(
							'metadata_version',
						),
						readme: sql<
							Release['readme']
						>`${observation.readme === null ? null : JSON.stringify(observation.readme)}`.as(
							'readme',
						),
						license: sql<string | null>`${observation.license}`.as('license'),
						distTags: sql<Record<string, string>>`${JSON.stringify(observation.distTags)}`.as(
							'dist_tags',
						),
						observedAt: sql<number>`${observation.observedAt}`.as('observed_at'),
						hidden: sql<boolean>`0`.as('hidden'),
						revision: sql<number>`1`.as('revision'),
						official: sql<boolean>`0`.as('official'),
						category: sql<null>`null`.as('category'),
						tags: sql<string[]>`'[]'`.as('tags'),
					})
					.from(sql`(select 1)`)
					.where(noConflict),
			)
			.onConflictDoUpdate({
				target: [packages.registry, packages.name],
				set: {
					description: observation.description,
					repository: observation.repository,
					metadataVersion: observation.metadataVersion,
					readme: observation.readme,
					license: observation.license,
					repositoryStars: sql`case when ${packages.repository} = ${observation.repository} then ${packages.repositoryStars} else null end`,
					repositoryObservedAt: sql`case when ${packages.repository} = ${observation.repository} then ${packages.repositoryObservedAt} else null end`,
					distTags: observation.distTags,
					observedAt: observation.observedAt,
				},
				setWhere: lt(packages.observedAt, observation.observedAt),
			}),
		db
			.insert(releases)
			.select(
				db
					.select({
						registry: sql<string>`${release.registry}`.as('registry'),
						name: sql<string>`${release.name}`.as('name'),
						version: sql<string>`${release.version}`.as('version'),
						tarball: sql<string>`${release.tarball}`.as('tarball'),
						integrity: sql<string>`${release.integrity}`.as('integrity'),
						checkedAt: sql<number>`${release.checkedAt}`.as('checked_at'),
						provenance: sql<Release['provenance']>`${JSON.stringify(release.provenance)}`.as(
							'provenance',
						),
						peerDependencies: sql<
							Record<string, string>
						>`${JSON.stringify(release.peerDependencies)}`.as('peer_dependencies'),
						pluginPackages: sql<
							Release['pluginPackages']
						>`${JSON.stringify(release.pluginPackages)}`.as('plugin_packages'),
						readme: sql<
							Release['readme']
						>`${release.readme === null ? null : JSON.stringify(release.readme)}`.as('readme'),
						license: sql<string | null>`${release.license}`.as('license'),
					})
					.from(sql`(select 1)`)
					.where(noConflict),
			)
			.onConflictDoNothing(),
		db.insert(audits).select(
			db
				.select({
					id: sql<string>`${crypto.randomUUID()}`.as('id'),
					registry: sql<string>`${release.registry}`.as('registry'),
					name: sql<string>`${release.name}`.as('name'),
					action: sql<string>`'refresh'`.as('action'),
					revision: sql<null>`null`.as('revision'),
					changes: sql<null>`null`.as('changes'),
					at: sql<number>`${release.checkedAt}`.as('at'),
				})
				.from(sql`(select 1)`)
				.where(noConflict),
		),
	])
	const stored = await getRelease(db, release, true)
	if (stored?.integrity !== release.integrity)
		throw new MarketError(
			'immutable-release-conflict',
			'npm returned different bytes for an already indexed release',
			409,
		)
	return stored
}

/** Discovery does not create a checked release or settle any notification. */
export async function commitObservation(
	db: Database,
	input: PackageIdentity,
	observation: Observation,
) {
	await db
		.insert(packages)
		.values({ ...input, ...observation })
		.onConflictDoUpdate({
			target: [packages.registry, packages.name],
			set: {
				...observation,
				repositoryStars: sql`case when ${packages.repository} = ${observation.repository} then ${packages.repositoryStars} else null end`,
				repositoryObservedAt: sql`case when ${packages.repository} = ${observation.repository} then ${packages.repositoryObservedAt} else null end`,
			},
			setWhere: lt(packages.observedAt, observation.observedAt),
		})
	return db
		.select()
		.from(packages)
		.where(and(eq(packages.registry, input.registry), eq(packages.name, input.name)))
		.get()
}

export async function getRelease(
	db: Database,
	input: Coordinate,
	includeHidden = false,
): Promise<Release | null> {
	const row = await db
		.select({ release: releases })
		.from(releases)
		.innerJoin(
			packages,
			and(eq(packages.registry, releases.registry), eq(packages.name, releases.name)),
		)
		.where(
			and(
				eq(releases.registry, input.registry),
				eq(releases.name, input.name),
				eq(releases.version, input.version),
				includeHidden ? undefined : eq(packages.hidden, false),
			),
		)
		.get()
	return row?.release ?? null
}

export async function listPackages(
	db: Database,
	input: PackageQuery,
	visibleRegistries: readonly string[],
): Promise<PackagePage> {
	const query = input.query ?? ''
	if (typeof query !== 'string' || query.length > 100)
		throw new MarketError('invalid-query', 'query must contain at most 100 characters')
	if (
		(input.official !== undefined && typeof input.official !== 'boolean') ||
		(input.category !== undefined && !taxonomySlug(input.category)) ||
		(input.tag !== undefined && !taxonomySlug(input.tag))
	)
		throw new MarketError(
			'invalid-query',
			'Use a boolean official filter and lowercase category/tag slugs',
		)
	const limit = pageLimit(input.limit)
	const scope = JSON.stringify([
		visibleRegistries,
		query,
		input.registry ?? null,
		input.official ?? null,
		input.category ?? null,
		input.tag ?? null,
	])
	const after = decodeCursor(input.cursor, scope)
	if (
		after !== null &&
		(!object(after) ||
			!packageName(after.name) ||
			typeof after.registry !== 'string' ||
			Object.keys(after).length !== 2)
	)
		throw new MarketError('invalid-cursor', 'Invalid package cursor; restart the query')
	const terms = query.match(/[\p{L}\p{N}]+/gu) ?? []
	// Each term is quoted data, never an FTS operator supplied by a requester.
	const match = terms.map((term) => `"${term}"*`).join(' AND ')
	if (visibleRegistries.length === 0) return { packages: [], nextCursor: null }
	const rows = await db
		.select({
			registry: packages.registry,
			name: packages.name,
			description: packages.description,
			distTags: packages.distTags,
			observedAt: packages.observedAt,
			repository: packages.repository,
			repositoryStars: packages.repositoryStars,
			repositoryObservedAt: packages.repositoryObservedAt,
			official: packages.official,
			category: packages.category,
			tags: packages.tags,
			indexedVersions: sql<number>`(select count(*) from releases indexed_release where indexed_release.registry = packages.registry and indexed_release.name = packages.name)`,
		})
		.from(packages)
		.where(
			and(
				eq(packages.hidden, false),
				inArray(packages.registry, [...visibleRegistries]),
				input.registry === undefined ? undefined : eq(packages.registry, input.registry),
				input.official === undefined ? undefined : eq(packages.official, input.official),
				input.category === undefined ? undefined : eq(packages.category, input.category),
				input.tag === undefined
					? undefined
					: sql`exists (select 1 from json_each(${packages.tags}) where value = ${input.tag})`,
				after === null
					? undefined
					: or(
							gt(packages.name, after.name as string),
							and(
								eq(packages.name, after.name as string),
								gt(packages.registry, after.registry as string),
							),
						),
				query
					? match
						? sql`${packages}.rowid in (select rowid from package_search where package_search match ${match})`
						: sql`0`
					: undefined,
			),
		)
		.orderBy(asc(packages.name), asc(packages.registry))
		.limit(limit + 1)
	const selected = rows.slice(0, limit)
	return {
		packages: selected.map((row) => ({
			registry: row.registry,
			name: row.name,
			description: row.description,
			latest: row.distTags.latest ?? null,
			repository: row.repository,
			repositoryStars: row.repositoryStars,
			repositoryObservedAt: row.repositoryObservedAt,
			indexedVersions: row.indexedVersions,
			observedAt: row.observedAt,
			official: row.official,
			category: row.category,
			tags: row.tags,
		})),
		nextCursor:
			rows.length > limit
				? encodeCursor(scope, { name: selected.at(-1)!.name, registry: selected.at(-1)!.registry })
				: null,
	}
}

export async function listNotifications(db: Database, input: NotificationQuery = {}) {
	if (
		!object(input) ||
		Object.keys(input).some(
			(key) => !['registry', 'name', 'status', 'code', 'cursor', 'limit'].includes(key),
		) ||
		(input.name !== undefined && !packageName(input.name)) ||
		(input.registry !== undefined && typeof input.registry !== 'string') ||
		(input.status !== undefined &&
			!['pending', 'processing', 'indexed', 'failed'].includes(input.status)) ||
		(input.code !== undefined &&
			(typeof input.code !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(input.code)))
	)
		throw new MarketError('invalid-query', 'Invalid notification filters')
	const limit = pageLimit(input.limit)
	const scope = JSON.stringify([
		'notifications',
		input.registry ?? null,
		input.name ?? null,
		input.status ?? null,
		input.code ?? null,
	])
	const after = decodeCursor(input.cursor, scope)
	if (
		after !== null &&
		(!object(after) ||
			!Number.isSafeInteger(after.createdAt) ||
			(after.createdAt as number) < 0 ||
			typeof after.id !== 'string' ||
			!/^[\w-]{1,64}$/.test(after.id) ||
			Object.keys(after).length !== 2)
	)
		throw new MarketError('invalid-cursor', 'Invalid notification cursor; restart the query')
	const rows = await db
		.select()
		.from(notifications)
		.where(
			and(
				input.registry === undefined ? undefined : eq(notifications.registry, input.registry),
				input.name === undefined ? undefined : eq(notifications.name, input.name),
				input.status === undefined ? undefined : eq(notifications.status, input.status),
				input.code === undefined ? undefined : eq(notifications.code, input.code),
				after === null
					? undefined
					: or(
							lt(notifications.createdAt, after.createdAt as number),
							and(
								eq(notifications.createdAt, after.createdAt as number),
								lt(notifications.id, after.id as string),
							),
						),
			),
		)
		.orderBy(desc(notifications.createdAt), desc(notifications.id))
		.limit(limit + 1)
	return {
		notifications: rows.slice(0, limit).map(notificationDetail),
		nextCursor:
			rows.length > limit
				? encodeCursor(scope, { createdAt: rows[limit - 1].createdAt, id: rows[limit - 1].id })
				: null,
	}
}

export async function facets(db: Database, visibleRegistries: readonly string[]) {
	if (visibleRegistries.length === 0) return { categories: [], tags: [] }
	const visible = and(
		eq(packages.hidden, false),
		inArray(packages.registry, [...visibleRegistries]),
	)
	const categories = await db
		.select({ value: packages.category, count: sql<number>`count(*)` })
		.from(packages)
		.where(and(visible, sql`${packages.category} is not null`))
		.groupBy(packages.category)
		.orderBy(asc(packages.category))
	const tags = await db
		.select({ value: sql<string>`tag.value`, count: sql<number>`count(*)` })
		.from(packages)
		.innerJoin(sql`json_each(${packages.tags}) tag`, sql`true`)
		.where(visible)
		.groupBy(sql`tag.value`)
		.orderBy(sql`tag.value`)
	return { categories, tags }
}

export async function setVisibility(
	db: Database,
	input: PackageIdentity & { expectedRevision: number; hidden: boolean },
	now: number,
) {
	return editPackage(db, input, { hidden: input.hidden }, input.hidden ? 'hide' : 'show', now)
}

export async function setMetadata(
	db: Database,
	input: PackageIdentity & MarketMetadata & { expectedRevision: number },
	now: number,
) {
	return editPackage(
		db,
		input,
		{ official: input.official, category: input.category, tags: input.tags },
		'metadata',
		now,
	)
}

async function editPackage(
	db: Database,
	input: PackageIdentity & { expectedRevision: number },
	changes: MarketMetadata | { hidden: boolean },
	action: string,
	now: number,
) {
	const identity = and(eq(packages.registry, input.registry), eq(packages.name, input.name))
	const matches = and(identity, eq(packages.revision, input.expectedRevision))
	const [, changed] = await db.batch([
		db.insert(audits).select(
			db
				.select({
					id: sql<string>`${crypto.randomUUID()}`.as('id'),
					registry: packages.registry,
					name: packages.name,
					action: sql<string>`${action}`.as('action'),
					revision: sql<number>`${input.expectedRevision + 1}`.as('revision'),
					changes: sql<MarketMetadata | { hidden: boolean }>`${JSON.stringify(changes)}`.as(
						'changes',
					),
					at: sql<number>`${now}`.as('at'),
				})
				.from(packages)
				.where(matches),
		),
		db
			.update(packages)
			.set({ ...changes, revision: input.expectedRevision + 1 })
			.where(matches)
			.returning(),
	])
	if (changed[0]) return { status: 'updated' as const, record: changed[0] }
	const current = await db.select().from(packages).where(identity).get()
	return current
		? { status: 'conflict' as const, currentRevision: current.revision }
		: { status: 'not-found' as const }
}
