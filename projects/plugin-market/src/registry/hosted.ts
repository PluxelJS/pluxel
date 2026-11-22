import { and, asc, eq } from 'drizzle-orm'
import { validRange } from 'semver'
import type { Database } from '../db/d1'
import {
	authorizeGitHubPublisher,
	githubPublishers,
	type GitHubPublisher,
} from './github-publisher'
import { commitHostedRelease } from './hosted-store'
import { archiveIntegrity, inspectTarball } from './tarball'
import { exactVersion, MarketError, object, packageName, readJson, registryBase } from '../protocol'
import type { PackageReview } from './review'
import { hostedReleases, hostedTags } from '../db/schema'

const archiveLimit = 4 * 1024 * 1024
const packageRoute = /^(@[^/]+\/[^/]+|[^/]+)(?:\/(.+))?$/
type HostedRelease = typeof hostedReleases.$inferSelect

function badPublish(): never {
	throw new MarketError(
		'invalid-publish',
		'Expected one scoped package version, dist-tag and tarball',
	)
}

function publishInput(input: unknown, name: string) {
	if (
		!object(input) ||
		!object(input.versions) ||
		!object(input._attachments) ||
		!object(input['dist-tags'])
	)
		return badPublish()
	const versions = Object.entries(input.versions)
	const tags = Object.entries(input['dist-tags'])
	const attachments = Object.values(input._attachments)
	const [version, manifest] = versions[0] ?? []
	const [tag, target] = tags[0] ?? []
	const attachment = attachments[0]
	if (
		versions.length !== 1 ||
		tags.length !== 1 ||
		attachments.length !== 1 ||
		!exactVersion(version) ||
		!object(manifest) ||
		manifest.name !== name ||
		manifest.version !== version ||
		typeof tag !== 'string' ||
		!/^[a-z][a-z0-9._-]{0,63}$/.test(tag) ||
		validRange(tag) !== null ||
		target !== version ||
		!object(attachment) ||
		typeof attachment.data !== 'string'
	)
		return badPublish()
	let bytes: Uint8Array<ArrayBuffer>
	try {
		bytes = Uint8Array.from(atob(attachment.data), (letter) => letter.charCodeAt(0))
	} catch {
		return badPublish()
	}
	if (bytes.byteLength === 0 || attachment.length !== bytes.byteLength) return badPublish()
	if (bytes.byteLength > archiveLimit)
		throw new MarketError(
			'archive-too-large',
			'Hosted archives may contain at most 4 MiB compressed',
			413,
		)
	return { version, tag, bytes }
}

function encodedPackage(name: string) {
	return name.split('/').map(encodeURIComponent).join('/')
}

function publishedManifest(row: HostedRelease) {
	return {
		...row.manifest,
		dist: {
			...(object(row.manifest.dist) ? row.manifest.dist : {}),
			tarball: `${row.registry}/${encodedPackage(row.name)}/-/${encodeURIComponent(row.version)}.tgz`,
			integrity: row.integrity,
			shasum: row.shasum,
		},
	}
}

type HostedStorage = Readonly<{ db: Database; archives: R2Bucket; readToken?: string }>

/** Trusted publishers and review policy shared by events in the same deployment. */
export class HostedRegistry {
	readonly url: string
	private readonly publishers: readonly GitHubPublisher[]

	constructor(
		url: string | undefined,
		publishers: string | undefined,
		private readonly review: PackageReview,
	) {
		if (!url || !publishers || registryBase(url) !== url || new URL(url).pathname !== '/npm')
			throw new Error(
				'Hosted registry requires a canonical HOSTED_REGISTRY_URL ending /npm and HOSTED_PUBLISHERS',
			)
		this.publishers = githubPublishers(JSON.parse(publishers))
		if (this.publishers.length === 0)
			throw new Error('The hosted registry requires a trusted publisher')
		this.url = url
	}

	async fetch(request: Request, storage: HostedStorage): Promise<Response> {
		try {
			const response = await this.dispatch(request, storage)
			response.headers.set('Cache-Control', 'no-store')
			return response
		} catch (error) {
			if (!(error instanceof MarketError)) throw error
			return Response.json(
				{ error: error.message, code: error.code },
				{
					status: error.status,
					headers: { 'Cache-Control': 'no-store' },
				},
			)
		}
	}

	private async dispatch(request: Request, storage: HostedStorage) {
		const { db, archives, readToken } = storage
		const url = new URL(request.url)
		const notFound = () => new MarketError('not-found', 'Package or release not found', 404)
		if (url.origin !== new URL(this.url).origin || !url.pathname.startsWith('/npm/'))
			throw notFound()
		let path: string
		try {
			path = decodeURIComponent(url.pathname.slice('/npm/'.length))
		} catch {
			throw notFound()
		}
		const tags = /^-\/package\/(.+)\/dist-tags$/.exec(path)
		const nameAndRest = tags ? [null, tags[1], undefined] : packageRoute.exec(path)
		const [, name, rest] = nameAndRest ?? []
		if (!packageName(name) || !name.startsWith('@')) throw notFound()
		if (request.method === 'PUT' && !tags && rest === undefined)
			return this.publish(request, name, storage)
		if (request.method !== 'GET' && request.method !== 'HEAD')
			throw new MarketError('method-not-allowed', 'Registry method not supported', 405)
		if (readToken && request.headers.get('Authorization') !== `Bearer ${readToken}`)
			throw new MarketError('unauthorized', 'Registry reads require a read credential', 401)
		const releaseKey = and(eq(hostedReleases.registry, this.url), eq(hostedReleases.name, name))
		if (rest != null) {
			const archive = /^-\/(.+)\.tgz$/.exec(rest)
			const version = archive ? archive[1] : rest
			if (!exactVersion(version)) throw notFound()
			const row = await db
				.select()
				.from(hostedReleases)
				.where(and(releaseKey, eq(hostedReleases.version, version)))
				.get()
			if (!row) throw notFound()
			if (!archive) return Response.json(publishedManifest(row))
			const body =
				request.method === 'HEAD'
					? await archives.head(row.archiveKey)
					: await archives.get(row.archiveKey)
			if (!body)
				throw new MarketError(
					'archive-unavailable',
					'The committed package archive is unavailable',
					503,
				)
			return new Response(
				'body' in body && body.body instanceof ReadableStream ? body.body : null,
				{
					headers: {
						'Content-Type': 'application/octet-stream',
						'Content-Length': String(body.size),
						ETag: body.httpEtag,
					},
				},
			)
		}
		const readTags = db
			.select({ tag: hostedTags.tag, version: hostedTags.version })
			.from(hostedTags)
			.where(and(eq(hostedTags.registry, this.url), eq(hostedTags.name, name)))
		if (tags) {
			const rows = await readTags
			return Response.json(Object.fromEntries(rows.map(({ tag, version }) => [tag, version])))
		}
		const [tagRows, rows] = await db.batch([
			readTags,
			db.select().from(hostedReleases).where(releaseKey).orderBy(asc(hostedReleases.version)),
		])
		if (tagRows.length === 0) throw notFound()
		const distTags = Object.fromEntries(tagRows.map(({ tag, version }) => [tag, version]))
		return Response.json({
			name,
			'dist-tags': distTags,
			versions: Object.fromEntries(rows.map((row) => [row.version, publishedManifest(row)])),
			time: Object.fromEntries(
				rows.map((row) => [row.version, new Date(row.publishedAt).toISOString()]),
			),
		})
	}

	private async publish(request: Request, name: string, { db, archives }: HostedStorage) {
		const publisher = await authorizeGitHubPublisher(
			request,
			this.publishers.filter((rule) => rule.name === name),
			this.url,
		)
		const { version, tag, bytes } = publishInput(
			await readJson(request.body, 6 * 1024 * 1024),
			name,
		)
		const facts = await inspectTarball(bytes, { registry: this.url, name, version })
		this.review(facts)
		const [integrity, sha1] = await Promise.all([
			archiveIntegrity(bytes),
			crypto.subtle.digest('SHA-1', bytes),
		])
		const shasum = Array.from(new Uint8Array(sha1), (byte) =>
			byte.toString(16).padStart(2, '0'),
		).join('')
		const manifest = Object.fromEntries(
			Object.entries(facts.manifest).filter(
				([key]) => key !== 'dist' && key !== 'publishConfig' && !key.startsWith('_'),
			),
		)
		if (manifest.private === true) return badPublish()
		request.signal.throwIfAborted()
		await commitHostedRelease(db, archives, {
			release: {
				registry: this.url,
				name,
				version,
				integrity,
				shasum,
				manifest: { ...manifest, dist: { unpackedSize: facts.unpackedBytes } },
				publisher,
			},
			tag,
			bytes,
		})
		return Response.json({ ok: true, id: name, rev: version }, { status: 201 })
	}
}
