import { and, eq, exists, lt, ne, notExists, sql } from 'drizzle-orm'
import { getRelease } from '../catalog/queries'
import { retainedRepositoryObservation, type Observation } from '../catalog/write'
import type { Database } from '../db/d1'
import { audits, notifications, packages, releases } from '../db/schema'
import { MarketError, repositoryOwner, type Release } from '../protocol'
import { activeLease, type Notification } from './notifications'

export async function commitRelease(
	db: Database,
	release: Release,
	observation: Observation,
	task?: Notification,
) {
	const now = Date.now()
	const owner = repositoryOwner(observation.repository)
	if (
		task &&
		(task.registry !== release.registry ||
			task.name !== release.name ||
			task.version !== release.version)
	)
		throw new Error('The release must match its notification coordinate')
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
	const lease = task ? activeLease(task, now) : undefined
	const canCommit = and(
		noConflict,
		lease &&
			exists(
				db
					.select({ one: sql`1` })
					.from(notifications)
					.where(lease),
			),
	)
	// Indexing and receipt settlement share the same D1 transaction and lease.
	const results = await db.batch([
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
						repositoryOwner: sql<string | null>`${owner}`.as('repository_owner'),
						repositoryAvatarUrl: sql<null>`null`.as('repository_avatar_url'),
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
					.where(canCommit),
			)
			.onConflictDoUpdate({
				target: [packages.registry, packages.name],
				set: {
					description: observation.description,
					repository: observation.repository,
					repositoryOwner: owner,
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
					.where(canCommit),
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
				.where(canCommit),
		),
		...(task
			? [
					db
						.update(notifications)
						.set({
							status: 'indexed',
							updatedAt: now,
							code: null,
							diagnostic: null,
							leaseToken: null,
							leaseUntil: null,
						})
						.where(and(lease, noConflict))
						.returning({ id: notifications.id }),
				]
			: []),
	])
	const stored = await getRelease(db, release, true)
	if (task && !results[3]?.length && (!stored || stored.integrity === release.integrity))
		throw new MarketError('notification-lease-lost', 'The indexing lease expired or changed', 409)
	if (stored?.integrity !== release.integrity)
		throw new MarketError(
			'immutable-release-conflict',
			'npm returned different bytes for an already indexed release',
			409,
		)
	return stored
}
