import { and, eq, exists, sql } from 'drizzle-orm'
import type { Database } from '../db/d1'
import { hostedReleases, hostedTags } from '../db/schema'
import { MarketError } from '../protocol'

type HostedPublish = {
	release: Omit<typeof hostedReleases.$inferInsert, 'archiveKey' | 'publishedAt'>
	tag: string
	bytes: Uint8Array<ArrayBuffer>
}

export async function commitHostedRelease(
	db: Database,
	archives: R2Bucket,
	{ release, tag, bytes }: HostedPublish,
) {
	const { registry, name, version } = release
	const archiveKey = crypto.randomUUID()
	// R2 is written before the transaction. A lost D1 acknowledgement must not delete a referenced object.
	const saved = await archives.put(archiveKey, bytes)
	if (!saved)
		throw new MarketError('archive-unavailable', 'The package archive could not be stored', 503)
	const won = exists(
		db
			.select({ one: sql`1` })
			.from(hostedReleases)
			.where(
				and(
					eq(hostedReleases.registry, registry),
					eq(hostedReleases.name, name),
					eq(hostedReleases.version, version),
					eq(hostedReleases.archiveKey, archiveKey),
				),
			),
	)
	const [inserted] = await db.batch([
		db
			.insert(hostedReleases)
			.values({ ...release, archiveKey, publishedAt: Date.now() })
			.onConflictDoNothing()
			.returning({ version: hostedReleases.version }),
		db
			.insert(hostedTags)
			.select(
				db
					.select({
						registry: sql<string>`${registry}`.as('registry'),
						name: sql<string>`${name}`.as('name'),
						tag: sql<string>`${tag}`.as('tag'),
						version: sql<string>`${version}`.as('version'),
					})
					.from(sql`(select 1)`)
					.where(won),
			)
			.onConflictDoUpdate({
				target: [hostedTags.registry, hostedTags.name, hostedTags.tag],
				set: { version },
			}),
	])
	if (inserted.length === 0) {
		await archives.delete(archiveKey).catch(() => {})
		throw new MarketError('immutable-release-conflict', 'This version is already published', 409)
	}
}
