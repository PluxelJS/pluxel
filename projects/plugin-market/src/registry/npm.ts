import type { Observation } from '../catalog/write'
import {
	MarketError,
	exactVersion,
	object,
	readBytes,
	parseJsonBytes,
	type Coordinate,
	type PackageIdentity,
	type Release,
} from '../protocol'
import type { PackageReview } from './review'
import type { RegistrySource } from './sources'
import { archiveIntegrity, inspectTarball, metadataBytes, repositoryLink } from './tarball'

const tarballBytes = 16 * 1024 * 1024
let activeRefreshes = 0

export const provenanceUnavailable = () =>
	new MarketError(
		'provenance-runtime-unsupported',
		'This Worker cannot yet verify npm provenance. The release was not indexed; see the deployment README for the native Sigstore compatibility gate.',
		422,
	)

type MirrorRead = 'metadata' | 'archive'

async function npmResponse(
	url: string,
	source: RegistrySource,
	signal: AbortSignal,
	mirrorRead?: MirrorRead,
) {
	let parsed: URL
	try {
		parsed = new URL(url)
	} catch {
		throw new MarketError('disallowed-npm-url', 'npm metadata references an invalid URL', 422)
	}
	if (
		parsed.origin !== new URL(source.registry).origin ||
		!parsed.href.startsWith(`${source.registry}/`) ||
		parsed.username ||
		parsed.password ||
		parsed.search ||
		parsed.hash
	) {
		throw new MarketError(
			'disallowed-npm-url',
			'npm metadata references a URL outside the configured registry',
			422,
		)
	}
	let response: Response
	try {
		const mirror = mirrorRead && source.mirror
		const target = mirror ? mirror + parsed.href.slice(source.registry.length) : parsed.href
		const request = new Request(target, {
			redirect: 'manual',
			signal,
			headers: {
				Accept: 'application/json',
				...(!mirror && source.token ? { Authorization: `Bearer ${source.token}` } : {}),
			},
		})
		const transport = source.fetch ?? fetch
		response = await transport(request)
		// npmmirror serves archives through one public CDN hop. Metadata and private registries keep their redirect policy.
		if (
			mirrorRead === 'archive' &&
			mirror === 'https://registry.npmmirror.com' &&
			[301, 302, 303, 307, 308].includes(response.status)
		) {
			const location = URL.parse(response.headers.get('location') ?? '')
			if (
				location?.origin === 'https://cdn.npmmirror.com' &&
				location.pathname.startsWith('/packages/') &&
				!location.username &&
				!location.password &&
				!location.search &&
				!location.hash
			) {
				await response.body?.cancel()
				response = await transport(new Request(location, { redirect: 'manual', signal }))
			}
		}
	} catch {
		throw new MarketError('npm-unavailable', 'The npm request failed or timed out', 502, true)
	}
	if (!response.ok) {
		await response.body?.cancel()
		if (response.status >= 300 && response.status < 400)
			throw new MarketError('npm-redirect', 'npm redirects are not accepted', 422)
		throw new MarketError(
			'npm-unavailable',
			`npm returned HTTP ${response.status}`,
			502,
			response.status === 404 || response.status === 429 || response.status >= 500,
		)
	}
	return response
}

async function npmBytes(
	url: string,
	source: RegistrySource,
	signal: AbortSignal,
	limit: number,
	mirrorRead?: MirrorRead,
) {
	const response = await npmResponse(url, source, signal, mirrorRead)
	try {
		return await readBytes(response.body, limit)
	} catch (error) {
		if (error instanceof MarketError) throw error
		throw new MarketError(
			'npm-unavailable',
			'Reading the npm response failed or timed out',
			502,
			true,
		)
	}
}

async function npmJson(
	url: string,
	source: RegistrySource,
	signal: AbortSignal,
	limit: number,
	mirrorRead?: MirrorRead,
): Promise<unknown> {
	const bytes = await npmBytes(url, source, signal, limit, mirrorRead)
	return parseJsonBytes(bytes)
}

/** Observe browsing metadata without accepting a release for installation. */
export async function fetchObservation(
	input: PackageIdentity,
	source: RegistrySource,
	eventSignal?: AbortSignal,
): Promise<Observation> {
	eventSignal?.throwIfAborted()
	const observedAt = Date.now()
	const deadline = AbortSignal.timeout(30_000)
	const value = await npmJson(
		`${source.registry}/${encodeURIComponent(input.name)}`,
		source,
		eventSignal ? AbortSignal.any([eventSignal, deadline]) : deadline,
		2 * 1024 * 1024,
		'metadata',
	)
	if (
		!object(value) ||
		value.name !== input.name ||
		!object(value.versions) ||
		!object(value['dist-tags'])
	)
		throw new MarketError(
			'invalid-npm-metadata',
			'The registry did not return the selected package metadata',
			422,
		)
	const tags = value['dist-tags']
	if (
		Object.keys(tags).length > 100 ||
		Object.entries(tags).some(([tag, version]) => tag.length > 128 || !exactVersion(version)) ||
		!exactVersion(tags.latest)
	)
		throw new MarketError(
			'invalid-dist-tags',
			'The registry must provide a valid latest version',
			422,
		)
	const metadata = value.versions[tags.latest]
	if (!object(metadata) || metadata.name !== input.name || metadata.version !== tags.latest)
		throw new MarketError(
			'invalid-npm-metadata',
			'The latest tag does not reference valid package metadata',
			422,
		)
	return {
		description:
			typeof metadata.description === 'string' ? metadata.description.slice(0, 2000) : null,
		repository: repositoryLink(metadata.repository),
		metadataVersion: tags.latest,
		readme:
			typeof value.readme === 'string'
				? { text: value.readme.slice(0, 256 * 1024), truncated: value.readme.length > 256 * 1024 }
				: null,
		license: typeof metadata.license === 'string' ? metadata.license.slice(0, 256) : null,
		distTags: tags as Record<string, string>,
		observedAt,
	}
}

type ReleaseInspection = { review: PackageReview; signal?: AbortSignal }

export async function fetchRelease(
	input: Coordinate,
	source: RegistrySource,
	options: ReleaseInspection,
): Promise<{ release: Release; observation: Observation }> {
	options.signal?.throwIfAborted()
	// A tarball plus digest input can occupy several compressed-size buffers.
	// Keep that memory bounded across simultaneous HTTP batch sessions in an isolate.
	if (activeRefreshes !== 0)
		throw new MarketError(
			'refresh-busy',
			'Another release is being inspected by this Worker; retry later',
			503,
			true,
		)
	activeRefreshes++
	try {
		if (input.registry !== source.registry)
			throw new MarketError(
				'unconfigured-registry',
				'Selected source does not match the coordinate',
				422,
			)
		return await inspectRelease(input, source, options)
	} finally {
		activeRefreshes--
	}
}

async function inspectRelease(
	input: Coordinate,
	source: RegistrySource,
	{ review, signal: eventSignal }: ReleaseInspection,
) {
	const observedAt = Date.now()
	const deadline = AbortSignal.timeout(30_000)
	const signal = eventSignal ? AbortSignal.any([eventSignal, deadline]) : deadline
	const metadata = await npmJson(
		`${source.registry}/${encodeURIComponent(input.name)}/${encodeURIComponent(input.version)}`,
		source,
		signal,
		metadataBytes,
	)
	if (
		!object(metadata) ||
		metadata.name !== input.name ||
		metadata.version !== input.version ||
		!object(metadata.dist)
	) {
		throw new MarketError(
			'invalid-npm-metadata',
			'npm did not return the requested release metadata',
			422,
		)
	}
	if (metadata.dist.attestations !== undefined) throw provenanceUnavailable()
	const { tarball, integrity } = metadata.dist
	if (
		typeof tarball !== 'string' ||
		tarball.length > 2048 ||
		typeof integrity !== 'string' ||
		!/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity)
	) {
		throw new MarketError(
			'invalid-npm-integrity',
			'npm must provide one SHA-512 integrity and a tarball URL',
			422,
		)
	}
	const bytes = await npmBytes(tarball, source, signal, tarballBytes, 'archive')
	if ((await archiveIntegrity(bytes)) !== integrity)
		throw new MarketError(
			'integrity-mismatch',
			'Downloaded tarball does not match npm SHA-512 integrity',
			422,
		)
	const facts = await inspectTarball(bytes, input)
	const tags = await npmJson(
		`${source.registry}/-/package/${encodeURIComponent(input.name)}/dist-tags`,
		source,
		signal,
		16 * 1024,
		'metadata',
	)
	if (
		!object(tags) ||
		Object.keys(tags).length > 100 ||
		Object.entries(tags).some(([tag, version]) => tag.length > 128 || !exactVersion(version))
	) {
		throw new MarketError('invalid-dist-tags', 'npm returned invalid or oversized dist-tags', 422)
	}
	review(facts)
	const release: Release = {
		...input,
		tarball,
		integrity,
		checkedAt: Date.now(),
		provenance: { status: 'missing' },
		peerDependencies: facts.peerDependencies,
		pluginPackages: facts.pluginPackages,
		readme: facts.readme,
		license: facts.license,
	}
	const observation: Observation = {
		description: facts.description,
		repository: facts.repository,
		metadataVersion: input.version,
		readme: facts.readme,
		license: facts.license,
		distTags: tags as Record<string, string>,
		observedAt,
	}
	return { release, observation }
}
