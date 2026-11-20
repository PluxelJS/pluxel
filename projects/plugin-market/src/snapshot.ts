import { asc, eq } from 'drizzle-orm'
import * as v from 'valibot'
import {
	authorFields,
	effectiveAuthorId,
	packageDetailFields,
	releaseFields,
	releasePackage,
	visiblePackages,
	type CatalogDatabase,
} from './catalog'
import {
	catalogAuthorId,
	exactVersion,
	object,
	packageName,
	registryBase,
	taxonomySlug,
	type Release,
} from './protocol'
import { authors, packages, releases } from './schema'

export const snapshotByteLimit = 16 * 1024 * 1024

export type CatalogSnapshot = v.InferOutput<ReturnType<typeof snapshotSchema>>

export async function exportCatalogSnapshot(
	db: CatalogDatabase,
	registries: string[],
): Promise<CatalogSnapshot> {
	const visible = visiblePackages(registries)
	// These reads share one D1 transaction, including the visibility of joined releases and authors.
	const [packageRows, releaseRows, authorRows] = await db.batch([
		db
			.select({ ...packageDetailFields, authorId: effectiveAuthorId })
			.from(packages)
			.where(visible)
			.orderBy(asc(packages.registry), asc(packages.name)),
		db
			.select(releaseFields)
			.from(releases)
			.innerJoin(packages, releasePackage)
			.where(visible)
			.orderBy(asc(releases.registry), asc(releases.name), asc(releases.version)),
		db
			.select({ ...authorFields })
			.from(authors)
			.innerJoin(packages, eq(effectiveAuthorId, authors.id))
			.where(visible)
			.groupBy(authors.id)
			.orderBy(asc(authors.id)),
	])
	return {
		version: 1,
		registries,
		authors: authorRows,
		packages: packageRows,
		releases: releaseRows,
	}
}

function snapshotSchema() {
	const registry = v.pipe(
		v.string(),
		v.check((value) => {
			try {
				return registryBase(value) === value
			} catch {
				return false
			}
		}),
	)
	const version = v.pipe(
		v.string(),
		v.check((value: string) => exactVersion(value)),
	)
	const name = v.pipe(
		v.string(),
		v.check((value: string) => packageName(value)),
	)
	const authorId = v.pipe(v.string(), v.check(catalogAuthorId))
	const slug = v.pipe(
		v.string(),
		v.check((value: string) => taxonomySlug(value)),
	)
	const timestamp = v.pipe(v.number(), v.safeInteger(), v.minValue(0))
	const text = v.nullable(v.string())
	const readme = v.nullable(v.strictObject({ text: v.string(), truncated: v.boolean() }))
	const stringMap = v.custom<Record<string, string>>(
		(value) => object(value) && Object.values(value).every((item) => typeof item === 'string'),
	)
	return v.strictObject({
		version: v.literal(1),
		registries: v.pipe(v.array(registry), v.maxLength(20)),
		authors: v.array(
			v.strictObject({
				id: authorId,
				name: v.string(),
				kind: v.picklist(['github', 'market']),
				avatarUrl: text,
			}),
		),
		packages: v.array(
			v.strictObject({
				registry,
				name,
				authorId: v.nullable(authorId),
				description: text,
				repository: text,
				repositoryStars: v.nullable(timestamp),
				repositoryObservedAt: v.nullable(timestamp),
				metadataVersion: v.nullable(version),
				readme,
				license: text,
				distTags: stringMap,
				observedAt: timestamp,
				official: v.boolean(),
				category: v.nullable(slug),
				tags: v.array(slug),
			}),
		),
		releases: v.array(
			v.strictObject({
				registry,
				name,
				version,
				tarball: v.pipe(v.string(), v.url()),
				integrity: v.pipe(v.string(), v.regex(/^sha512-[A-Za-z0-9+/]{86}==$/)),
				checkedAt: timestamp,
				provenance: v.variant('status', [
					v.strictObject({ status: v.literal('missing') }),
					v.strictObject({
						status: v.literal('verified'),
						repository: v.string(),
						commit: v.string(),
						buildUrl: text,
					}),
				]),
				peerDependencies: stringMap,
				pluginPackages: v.custom<Release['pluginPackages']>(
					(value) =>
						object(value) &&
						Object.values(value).every((item) => item === 'required' || item === 'optional'),
				),
				readme,
				license: text,
			}),
		),
	})
}

export function decodeCatalogSnapshot(value: unknown): CatalogSnapshot {
	const parsed = v.safeParse(snapshotSchema(), value, { abortEarly: true })
	if (!parsed.success) {
		const field = parsed.issues[0].path?.map((item) => item.key).join('.')
		throw new Error(`Invalid catalog snapshot${field ? ` at ${field}` : ''}`)
	}
	const snapshot = parsed.output
	const registries = new Set(snapshot.registries)
	if (
		registries.size !== snapshot.registries.length ||
		snapshot.packages.some((item) => !registries.has(item.registry)) ||
		snapshot.releases.some((item) => !registries.has(item.registry))
	)
		throw new Error('Catalog snapshot contains an invalid public registry set')
	if (snapshot.authors.some((author) => !author.id.startsWith(`${author.kind}:`)))
		throw new Error('Catalog snapshot contains an invalid author identity')
	return snapshot
}
