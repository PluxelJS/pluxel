import { and, eq, isNull, lt, or, sql } from 'drizzle-orm'
import type { Database } from '../db/d1'
import { audits, packages } from '../db/schema'
import {
	repositoryOwner,
	type MarketCuration,
	type PackageIdentity,
	type Release,
} from '../protocol'
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
		repositoryAvatarUrl: sql`case when ${same} then ${packages.repositoryAvatarUrl} else null end`,
	}
}

/** Discovery does not create a checked release or settle any notification. */
export async function commitObservation(
	db: Database,
	input: PackageIdentity,
	observation: Observation,
) {
	const owner = repositoryOwner(observation.repository)
	await db
		.insert(packages)
		.values({ ...input, ...observation, repositoryOwner: owner })
		.onConflictDoUpdate({
			target: [packages.registry, packages.name],
			set: {
				...observation,
				repositoryOwner: owner,
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
	return db
		.update(packages)
		.set({
			repositoryStars: observed.stars,
			repositoryObservedAt: observed.observedAt,
			repositoryAvatarUrl: observed.avatarUrl,
		})
		.where(matches)
		.returning({
			repository: packages.repository,
			stars: packages.repositoryStars,
			observedAt: packages.repositoryObservedAt,
		})
		.get()
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
			...changes,
			revision: input.expectedRevision + 1,
		})
		.where(matches)
		.returning()
	const [, changed] = await db.batch([audit, update])
	if (changed[0]) return { status: 'updated' as const, record: changed[0] }
	const current = await db.select().from(packages).where(identity).get()
	return current
		? { status: 'conflict' as const, currentRevision: current.revision }
		: { status: 'not-found' as const }
}
