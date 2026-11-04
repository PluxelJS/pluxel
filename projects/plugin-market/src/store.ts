import { and, asc, eq, gt, gte, inArray, lt, lte, ne, notExists, or, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { audits, notifications, packages, releases } from './schema'
import {
	MarketError,
	registry,
	type Coordinate,
	type PackagePage,
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
		registry,
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

export async function enqueue(db: Database, input: Coordinate, now: number): Promise<Notification> {
	const key = and(eq(notifications.name, input.name), eq(notifications.version, input.version))
	const existing = await db.select().from(notifications).where(key).get()
	if (existing) return existing
	// Admission limits belong in the INSERT: concurrent requests cannot all pass a prior COUNT.
	const admitted = and(
		sql`(select count(*) from ${notifications}) < 5000`,
		sql`(select count(*) from ${notifications} where ${notifications.createdAt} >= ${now - 60_000}) < 100`,
		sql`(select count(*) from ${notifications} where ${notifications.name} = ${input.name}
			and ${notifications.status} in ('pending', 'processing')) < 10`,
	)
	const rows = await db
		.insert(notifications)
		.select(
			db
				.select({
					id: sql<string>`${crypto.randomUUID()}`.as('id'),
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
	if (row.code === 'provenance-runtime-unsupported')
		return { status: 'unavailable' as const, code: row.code }
	if (row.status !== 'failed' || row.attempts >= maxAttempts)
		return { status: 'not-retryable' as const, receipt: receipt(row) }
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
						name: sql<string>`${release.name}`.as('name'),
						description: sql<string | null>`${observation.description}`.as('description'),
						distTags: sql<Record<string, string>>`${JSON.stringify(observation.distTags)}`.as(
							'dist_tags',
						),
						observedAt: sql<number>`${observation.observedAt}`.as('observed_at'),
						hidden: sql<boolean>`0`.as('hidden'),
						revision: sql<number>`1`.as('revision'),
					})
					.from(sql`(select 1)`)
					.where(noConflict),
			)
			.onConflictDoUpdate({
				target: packages.name,
				set: {
					description: observation.description,
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
					})
					.from(sql`(select 1)`)
					.where(noConflict),
			)
			.onConflictDoNothing(),
		db.insert(audits).select(
			db
				.select({
					id: sql<string>`${crypto.randomUUID()}`.as('id'),
					name: sql<string>`${release.name}`.as('name'),
					action: sql<string>`'refresh'`.as('action'),
					revision: sql<null>`null`.as('revision'),
					at: sql<number>`${release.checkedAt}`.as('at'),
				})
				.from(sql`(select 1)`)
				.where(noConflict),
		),
	])
	const stored = await getRelease(db, release.name, release.version, true)
	if (stored?.integrity !== release.integrity)
		throw new MarketError(
			'immutable-release-conflict',
			'npm returned different bytes for an already indexed release',
			409,
		)
	return stored
}

export async function getRelease(
	db: Database,
	name: string,
	version: string,
	includeHidden = false,
): Promise<Release | null> {
	const row = await db
		.select({ release: releases })
		.from(releases)
		.innerJoin(packages, eq(packages.name, releases.name))
		.where(
			and(
				eq(releases.name, name),
				eq(releases.version, version),
				includeHidden ? undefined : eq(packages.hidden, false),
			),
		)
		.get()
	return row ? { registry, ...row.release } : null
}

export async function listPackages(
	db: Database,
	query: string,
	after: string | null,
	limit: number,
): Promise<PackagePage> {
	const filter = query.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')
	const rows = await db
		.select({
			name: packages.name,
			description: packages.description,
			distTags: packages.distTags,
			observedAt: packages.observedAt,
			indexedVersions: sql<number>`(select count(*) from releases indexed_release where indexed_release.name = packages.name)`,
		})
		.from(packages)
		.where(
			and(
				eq(packages.hidden, false),
				after === null ? undefined : gt(packages.name, after),
				query ? sql`${packages.name} like ${`%${filter}%`} escape ${'\\'}` : undefined,
			),
		)
		.orderBy(asc(packages.name))
		.limit(limit + 1)
	const selected = rows.slice(0, limit)
	return {
		packages: selected.map((row) => ({
			name: row.name,
			description: row.description,
			latest: row.distTags.latest ?? null,
			repository: null,
			indexedVersions: row.indexedVersions,
			observedAt: row.observedAt,
		})),
		nextCursor: rows.length > limit ? selected.at(-1)!.name : null,
	}
}

export async function setVisibility(
	db: Database,
	input: { name: string; expectedRevision: number; hidden: boolean },
	now: number,
) {
	const matches = and(eq(packages.name, input.name), eq(packages.revision, input.expectedRevision))
	const [, changed] = await db.batch([
		db.insert(audits).select(
			db
				.select({
					id: sql<string>`${crypto.randomUUID()}`.as('id'),
					name: packages.name,
					action: sql<string>`${input.hidden ? 'hide' : 'show'}`.as('action'),
					revision: sql<number>`${input.expectedRevision + 1}`.as('revision'),
					at: sql<number>`${now}`.as('at'),
				})
				.from(packages)
				.where(matches),
		),
		db
			.update(packages)
			.set({ hidden: input.hidden, revision: input.expectedRevision + 1 })
			.where(matches)
			.returning(),
	])
	if (changed[0]) return { status: 'updated' as const, record: changed[0] }
	const current = await db.select().from(packages).where(eq(packages.name, input.name)).get()
	return current
		? { status: 'conflict' as const, currentRevision: current.revision }
		: { status: 'not-found' as const }
}
