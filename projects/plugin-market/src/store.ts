import {
	and,
	asc,
	desc,
	eq,
	gt,
	gte,
	inArray,
	isNull,
	lt,
	lte,
	ne,
	notExists,
	or,
	sql,
	type SQL,
} from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { getRelease } from './catalog'
import { audits, authors, notifications, packages, releases } from './schema'
import {
	MarketError,
	decodeCursor,
	encodeCursor,
	object,
	packageName,
	pageLimit,
	type Coordinate,
	type MarketAuthor,
	type MarketCuration,
	type NotificationDetail,
	type NotificationQuery,
	type PackageIdentity,
	type Receipt,
	type Release,
} from './protocol'
import type { RepositoryObservation } from './repository'

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

function retainedRepositoryObservation(repository: string | null) {
	const same = sql`${packages.repository} = ${repository}`
	return {
		repositoryStars: sql`case when ${same} then ${packages.repositoryStars} else null end`,
		repositoryObservedAt: sql`case when ${same} then ${packages.repositoryObservedAt} else null end`,
		repositoryAuthorId: sql`case when ${same} then ${packages.repositoryAuthorId} else null end`,
	}
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
						repositoryAuthorId: sql<null>`null`.as('repository_author_id'),
						curatedAuthorId: sql<null>`null`.as('curated_author_id'),
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
					...retainedRepositoryObservation(observation.repository),
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
				...retainedRepositoryObservation(observation.repository),
			},
			setWhere: lt(packages.observedAt, observation.observedAt),
		})
	return db
		.select()
		.from(packages)
		.where(and(eq(packages.registry, input.registry), eq(packages.name, input.name)))
		.get()
}

function publishAuthor(db: Database, author: MarketAuthor, now: number, matches: SQL | undefined) {
	return db
		.insert(authors)
		.select(
			db
				.select({
					id: sql<string>`${author.id}`.as('id'),
					name: sql<string>`${author.name}`.as('name'),
					kind: sql<MarketAuthor['kind']>`${author.kind}`.as('kind'),
					avatarUrl: sql<string | null>`${author.avatarUrl}`.as('avatar_url'),
					observedAt: sql<number>`${now}`.as('observed_at'),
				})
				.from(packages)
				.where(matches),
		)
		.onConflictDoUpdate({
			target: authors.id,
			set: { name: author.name, avatarUrl: author.avatarUrl, observedAt: now },
			setWhere: lte(authors.observedAt, now),
		})
}

export async function commitRepositoryObservation(
	db: Database,
	input: PackageIdentity,
	repository: string,
	observed: RepositoryObservation,
) {
	const matches = and(
		eq(packages.registry, input.registry),
		eq(packages.name, input.name),
		eq(packages.repository, repository),
		or(
			isNull(packages.repositoryObservedAt),
			lt(packages.repositoryObservedAt, observed.observedAt),
		),
	)
	const [, changed] = await db.batch([
		publishAuthor(db, observed.author, observed.observedAt, matches),
		db
			.update(packages)
			.set({
				repositoryStars: observed.stars,
				repositoryObservedAt: observed.observedAt,
				repositoryAuthorId: observed.author.id,
			})
			.where(matches)
			.returning({
				repository: packages.repository,
				stars: packages.repositoryStars,
				observedAt: packages.repositoryObservedAt,
			}),
	])
	return changed[0]
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

export async function setVisibility(
	db: Database,
	input: PackageIdentity & { expectedRevision: number; hidden: boolean },
	now: number,
) {
	return editPackage(db, input, { hidden: input.hidden }, input.hidden ? 'hide' : 'show', now)
}

export async function setMetadata(
	db: Database,
	input: PackageIdentity & MarketCuration & { expectedRevision: number },
	now: number,
) {
	return editPackage(
		db,
		input,
		{
			official: input.official,
			category: input.category,
			tags: input.tags,
			...(input.author === undefined ? {} : { author: input.author }),
		},
		'metadata',
		now,
	)
}

async function editPackage(
	db: Database,
	input: PackageIdentity & { expectedRevision: number },
	changes: MarketCuration | { hidden: boolean },
	action: string,
	now: number,
) {
	const identity = and(eq(packages.registry, input.registry), eq(packages.name, input.name))
	const matches = and(identity, eq(packages.revision, input.expectedRevision))
	const { author, ...fields } = 'official' in changes ? changes : { ...changes, author: undefined }
	const audit = db.insert(audits).select(
		db
			.select({
				id: sql<string>`${crypto.randomUUID()}`.as('id'),
				registry: packages.registry,
				name: packages.name,
				action: sql<string>`${action}`.as('action'),
				revision: sql<number>`${input.expectedRevision + 1}`.as('revision'),
				changes: sql<MarketCuration | { hidden: boolean }>`${JSON.stringify(changes)}`.as(
					'changes',
				),
				at: sql<number>`${now}`.as('at'),
			})
			.from(packages)
			.where(matches),
	)
	const update = db
		.update(packages)
		.set({
			...fields,
			...(author === undefined ? {} : { curatedAuthorId: author?.id ?? null }),
			revision: input.expectedRevision + 1,
		})
		.where(matches)
		.returning()
	let changed
	if (author) {
		const [, , records] = await db.batch([
			publishAuthor(db, { ...author, kind: 'market', avatarUrl: null }, now, matches),
			audit,
			update,
		])
		changed = records
	} else {
		const [, records] = await db.batch([audit, update])
		changed = records
	}
	if (changed[0]) return { status: 'updated' as const, record: changed[0] }
	const current = await db.select().from(packages).where(identity).get()
	return current
		? { status: 'conflict' as const, currentRevision: current.revision }
		: { status: 'not-found' as const }
}
