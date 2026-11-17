import { and, eq, gt, lte, or, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { edits, notifications, registrations } from './schema'

export function connect(binding: D1Database) {
	return drizzle(binding)
}

type Database = ReturnType<typeof connect>

export async function editRegistration(
	db: Database,
	input: {
		id: string
		expectedRevision: number
		label: string
	},
	actor: string,
) {
	const matches = and(
		eq(registrations.id, input.id),
		eq(registrations.revision, input.expectedRevision),
	)
	// Both writes are gated. A zero-row UPDATE does not roll back a D1 batch.
	// The audit INSERT runs before the UPDATE in the same atomic batch.
	const [, changed] = await db.batch([
		db.insert(edits).select(
			db
				.select({
					id: sql<string>`${crypto.randomUUID()}`.as('id'),
					recordId: registrations.id,
					revision: sql<number>`${input.expectedRevision + 1}`.as('revision'),
					actor: sql<string>`${actor}`.as('actor'),
				})
				.from(registrations)
				.where(matches),
		),
		db
			.update(registrations)
			.set({
				label: input.label,
				revision: input.expectedRevision + 1,
			})
			.where(matches)
			.returning(),
	])
	if (changed[0]) return { status: 'updated' as const, record: changed[0] }
	const current = await db.select().from(registrations).where(eq(registrations.id, input.id)).get()
	return current
		? { status: 'conflict' as const, currentRevision: current.revision }
		: { status: 'not-found' as const }
}

export type Coordinate = { registry: string; packageName: string; version: string }

export async function enqueue(db: Database, coordinate: Coordinate) {
	const inserted = await db
		.insert(notifications)
		.values({ id: crypto.randomUUID(), ...coordinate })
		.onConflictDoNothing({
			target: [notifications.registry, notifications.packageName, notifications.version],
		})
		.returning()
	if (inserted[0]) return inserted[0]
	const existing = await db
		.select()
		.from(notifications)
		.where(
			and(
				eq(notifications.registry, coordinate.registry),
				eq(notifications.packageName, coordinate.packageName),
				eq(notifications.version, coordinate.version),
			),
		)
		.get()
	if (!existing) throw new Error('Notification disappeared after coordinate conflict')
	return existing
}

// Clock values are explicit so lease expiration can be checked without sleeps.
export async function claim(db: Database, id: string, now: number, leaseMs: number) {
	const rows = await db
		.update(notifications)
		.set({
			status: 'processing',
			attempt: sql`${notifications.attempt} + 1`,
			leaseToken: crypto.randomUUID(),
			leaseUntil: now + leaseMs,
		})
		.where(
			and(
				eq(notifications.id, id),
				or(
					eq(notifications.status, 'pending'),
					and(eq(notifications.status, 'processing'), lte(notifications.leaseUntil, now)),
				),
			),
		)
		.returning()
	return rows[0] ?? null
}

export async function failAttempt(
	db: Database,
	input: {
		id: string
		leaseToken: string
		now: number
		diagnostic: string
	},
) {
	const rows = await db
		.update(notifications)
		.set({
			status: 'failed',
			diagnostic: input.diagnostic,
			leaseToken: null,
			leaseUntil: null,
		})
		.where(
			and(
				eq(notifications.id, input.id),
				eq(notifications.status, 'processing'),
				eq(notifications.leaseToken, input.leaseToken),
				gt(notifications.leaseUntil, input.now),
			),
		)
		.returning({ id: notifications.id })
	return rows.length === 1
}
