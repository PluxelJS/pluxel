import { and, eq, isNull, lt, lte, or, sql, type SQL } from 'drizzle-orm'
import type { Database } from '../db/d1'
import { audits, authors, packages } from '../db/schema'
import type { MarketAuthor, MarketCuration, PackageIdentity, Release } from '../protocol'
import type { RepositoryObservation } from './repository'

export type Observation = {
	description: string | null
	repository: string | null
	metadataVersion: string | null
	readme: Release['readme']
	license: string | null
	distTags: Record<string, string>
	observedAt: number
}

export function retainedRepositoryObservation(repository: string | null) {
	const same = sql`${packages.repository} = ${repository}`
	return {
		repositoryStars: sql`case when ${same} then ${packages.repositoryStars} else null end`,
		repositoryObservedAt: sql`case when ${same} then ${packages.repositoryObservedAt} else null end`,
		repositoryAuthorId: sql`case when ${same} then ${packages.repositoryAuthorId} else null end`,
	}
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
