import { and, asc, eq } from 'drizzle-orm'
import * as v from 'valibot'
import { packageDetailFields, releaseFields, releasePackage, visiblePackages } from './queries'
import {
	exactVersion,
	object,
	packageName,
	registryBase,
	taxonomySlug,
	type Release,
} from '../protocol'
import type { Database } from '../db/d1'
import { packages, releases, snapshotState } from '../db/schema'
import { json, notModified } from '../http'

export const snapshotByteLimit = 16 * 1024 * 1024
const snapshotVersion = 2

export type CatalogSnapshot = v.InferOutput<ReturnType<typeof snapshotSchema>>

export async function catalogSnapshotResponse(
	request: Request,
	db: Database,
	registries: string[],
): Promise<Response> {
	const scope = JSON.stringify([snapshotVersion, registries])
	const selectState = db.select().from(snapshotState).where(eq(snapshotState.id, 1))
	if (request.headers.has('If-None-Match')) {
		const state = await selectState.get()
		if (state?.scope === scope && state.etag) {
			const cached = notModified(request, state.etag)
			if (cached) return cached
		}
	}
	const visible = visiblePackages(registries)
	// The revision, visible packages and joined releases must describe the same D1 transaction.
	const [[state], packageRows, releaseRows] = await db.batch([
		selectState,
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
	const snapshot: CatalogSnapshot = {
		version: snapshotVersion,
		registries,
		packages: packageRows,
		releases: releaseRows,
	}
	if (!state) throw new Error('Missing catalog snapshot state')
	const knownEtag = state.scope === scope ? (state.etag ?? undefined) : undefined
	const response = await json(request, snapshot, { snapshotByteLimit, knownEtag })
	if (!knownEtag) {
		// A concurrent catalog change must never acquire the ETag of the previous revision.
		await db
			.update(snapshotState)
			.set({ scope, etag: response.headers.get('ETag')! })
			.where(and(eq(snapshotState.id, 1), eq(snapshotState.revision, state.revision)))
	}
	return response
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
		version: v.literal(snapshotVersion),
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
