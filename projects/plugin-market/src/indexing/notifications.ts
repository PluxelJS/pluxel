import { and, asc, desc, eq, gt, gte, inArray, lt, lte, or, sql } from 'drizzle-orm'
import type { Database } from '../db/d1'
import { notifications } from '../db/schema'
import {
	MarketError,
	decodeCursor,
	encodeCursor,
	object,
	packageName,
	pageLimit,
	type Coordinate,
	type NotificationDetail,
	type NotificationQuery,
	type Receipt,
} from '../protocol'

export const maxAttempts = 3
const leaseMs = 60_000
const retentionMs = 7 * 24 * 60 * 60_000

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
	return {
		...receipt(row),
		diagnostic: row.diagnostic,
		githubPublisher: row.githubPublisher,
		retry: retryState(row),
	}
}

export async function enqueue(
	db: Database,
	input: Coordinate,
	now: number,
	githubPublisher: Notification['githubPublisher'] = null,
): Promise<Notification> {
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
					githubPublisher: sql<
						string | null
					>`${githubPublisher && JSON.stringify(githubPublisher)}`.as('github_publisher'),
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
		.where(activeLease(task, now))
		.returning({ id: notifications.id })
	return rows.length === 1
}

export function activeLease(task: Notification, now: number) {
	return and(
		eq(notifications.id, task.id),
		eq(notifications.status, 'processing'),
		task.leaseToken ? eq(notifications.leaseToken, task.leaseToken) : sql`0`,
		gt(notifications.leaseUntil, now),
	)
}

export function findNotification(db: Database, id: string) {
	return db.select().from(notifications).where(eq(notifications.id, id)).get()
}

export async function retryNotification(db: Database, id: string, now: number) {
	const row = await findNotification(db, id)
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
