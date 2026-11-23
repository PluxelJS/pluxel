import { asc } from 'drizzle-orm'
import * as v from 'valibot'
import {
	packageDetailFields,
	releaseFields,
	releasePackage,
	visiblePackages,
	type CatalogDatabase,
} from './queries'
import {
	exactVersion,
	object,
	packageName,
	registryBase,
	taxonomySlug,
	type Release,
} from '../protocol'
import { packages, releases } from '../db/schema'

export const snapshotByteLimit = 16 * 1024 * 1024

export type CatalogSnapshot = v.InferOutput<ReturnType<typeof snapshotSchema>>

export async function exportCatalogSnapshot(
	db: CatalogDatabase,
	registries: string[],
): Promise<CatalogSnapshot> {
	const visible = visiblePackages(registries)
	// These reads share one D1 transaction, including the visibility of joined releases.
	const [packageRows, releaseRows] = await db.batch([
		db
			.select({ ...packageDetailFields, repositoryAvatarUrl: packages.repositoryAvatarUrl })
			.from(packages)
			.where(visible)
			.orderBy(asc(packages.registry), asc(packages.name)),
		db
			.select(releaseFields)
			.from(releases)
			.innerJoin(packages, releasePackage)
			.where(visible)
			.orderBy(asc(releases.registry), asc(releases.name), asc(releases.version)),
	])
	return {
		version: 2,
		registries,
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
		version: v.literal(2),
		registries: v.pipe(v.array(registry), v.maxLength(20)),
		packages: v.array(
			v.strictObject({
				registry,
				name,
				description: text,
				repository: text,
				repositoryStars: v.nullable(timestamp),
				repositoryObservedAt: v.nullable(timestamp),
				repositoryAvatarUrl: v.nullable(
					v.pipe(v.string(), v.url(), v.startsWith('https://avatars.githubusercontent.com/')),
				),
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
	return snapshot
}
