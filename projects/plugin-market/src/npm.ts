import { createGzipDecoder, createTarDecoder } from 'modern-tar'
import semver from 'semver'
import {
	MarketError,
	exactVersion,
	object,
	packageName,
	readBytes,
	readJson,
	type Coordinate,
	type PackageIdentity,
	type Release,
} from './protocol'
import type { Observation } from './store'
import type { RegistrySource } from './sources'

const metadataBytes = 512 * 1024
const tarballBytes = 16 * 1024 * 1024
const expandedBytes = 64 * 1024 * 1024
const maxFiles = 2048
let activeRefreshes = 0

export const provenanceUnavailable = () =>
	new MarketError(
		'provenance-runtime-unsupported',
		'This Worker cannot yet verify npm provenance. The release was not indexed; see the deployment README for the native Sigstore compatibility gate.',
		422,
	)

async function npmResponse(url: string, source: RegistrySource, signal: AbortSignal) {
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
		response = await fetch(parsed.href, {
			redirect: 'manual',
			signal,
			headers: {
				Accept: 'application/json',
				...(source.token ? { Authorization: `Bearer ${source.token}` } : {}),
			},
		})
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

async function npmBytes(url: string, source: RegistrySource, signal: AbortSignal, limit: number) {
	const response = await npmResponse(url, source, signal)
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
): Promise<unknown> {
	const bytes = await npmBytes(url, source, signal, limit)
	return readJson(new Response(bytes).body, limit)
}

function stringMap(value: unknown, label: string): Record<string, string> {
	if (value === undefined) return {}
	if (!object(value) || Object.keys(value).length > 200)
		throw new MarketError('invalid-package', `${label} must be a bounded dependency map`, 422)
	for (const [name, range] of Object.entries(value)) {
		if (
			!packageName(name) ||
			typeof range !== 'string' ||
			range.length > 256 ||
			semver.validRange(range) === null
		) {
			throw new MarketError(
				'invalid-package',
				`${label}.${name} must be a published semver range`,
				422,
			)
		}
	}
	return value as Record<string, string>
}

function pathInPackage(path: string) {
	return (
		path.startsWith('package/') &&
		path.length <= 512 &&
		!path.includes('\\') &&
		!path.includes('\0') &&
		path.split('/').every((part) => part !== '..' && part !== '.')
	)
}

function exportTargets(value: unknown, depth = 0): string[] {
	if (depth > 12)
		throw new MarketError(
			'invalid-exports',
			'Package exports exceed the supported nesting depth',
			422,
		)
	if (typeof value === 'string') {
		if (
			!value.startsWith('./') ||
			value.includes('*') ||
			!pathInPackage(`package/${value.slice(2)}`)
		) {
			throw new MarketError(
				'invalid-exports',
				'Public exports must name explicit files inside the package',
				422,
			)
		}
		return [value.slice(2)]
	}
	if (value === null) return []
	if (Array.isArray(value)) return value.flatMap((entry) => exportTargets(entry, depth + 1))
	if (!object(value))
		throw new MarketError('invalid-exports', 'Expected explicit package exports', 422)
	return Object.entries(value).flatMap(([condition, target]) => {
		// Authoring conditions are not production exports and may be omitted from npm files.
		if (['@pluxel/hmr', '@pluxel/source', 'development'].includes(condition)) return []
		return exportTargets(target, depth + 1)
	})
}

async function inspectTarball(bytes: Uint8Array<ArrayBuffer>, input: Coordinate) {
	let expanded = 0
	let fileCount = 0
	let manifest: unknown
	let readme: Release['readme'] = null
	const files = new Set<string>()
	const paths = new Set<string>()
	const entries = new Response(bytes)
		.body!.pipeThrough(createGzipDecoder())
		.pipeThrough(
			new TransformStream<Uint8Array, Uint8Array>({
				transform(chunk, controller) {
					expanded += chunk.byteLength
					if (expanded > expandedBytes)
						throw new MarketError('expanded-size-limit', 'The expanded tarball exceeds 64 MiB', 422)
					controller.enqueue(chunk)
				},
			}),
		)
		.pipeThrough(createTarDecoder({ strict: true }))
	try {
		for await (const entry of entries) {
			fileCount++
			if (fileCount > maxFiles)
				throw new MarketError('file-count-limit', 'The tarball exceeds 2048 entries', 422)
			const path = entry.header.name
			if (!pathInPackage(path) || paths.has(path))
				throw new MarketError(
					'invalid-tarball-path',
					'Tarball paths must be unique and stay inside package/',
					422,
				)
			if (entry.header.type !== 'file' && entry.header.type !== 'directory')
				throw new MarketError(
					'invalid-tarball-entry',
					'Links and special files are not accepted',
					422,
				)
			paths.add(path)
			if (entry.header.type === 'file') files.add(path)
			if (entry.header.type === 'file' && path === 'package/package.json') {
				manifest = await readJson(entry.body, metadataBytes)
			} else if (
				entry.header.type === 'file' &&
				/^package\/readme(?:\.(?:md|markdown|txt))?$/i.test(path) &&
				readme === null
			) {
				const reader = entry.body.getReader()
				const decoder = new TextDecoder()
				let size = 0
				let text = ''
				let truncated = false
				try {
					for (;;) {
						const chunk = await reader.read()
						if (chunk.done) break
						const remaining = 256 * 1024 - size
						text += decoder.decode(chunk.value.subarray(0, remaining), { stream: true })
						size += chunk.value.length
						if (size > 256 * 1024) {
							truncated = true
							break
						}
					}
					text += decoder.decode()
					readme = { text, truncated }
				} finally {
					await reader.cancel()
					reader.releaseLock()
				}
			} else {
				await entry.body.cancel()
			}
		}
	} catch (error) {
		if (error instanceof MarketError) throw error
		throw new MarketError('invalid-tarball', 'The tarball is corrupt or unsupported', 422)
	}
	if (!object(manifest) || manifest.name !== input.name || manifest.version !== input.version) {
		throw new MarketError(
			'package-identity-mismatch',
			'Tarball package.json does not match the requested npm release',
			422,
		)
	}
	const peers = stringMap(manifest.peerDependencies, 'peerDependencies')
	if (!peers['@pluxel/core'])
		throw new MarketError(
			'missing-core-peer',
			'A plugin package must declare its @pluxel/core peer',
			422,
		)
	const targets = exportTargets(manifest.exports)
	if (!targets.some((path) => /\.(?:mjs|cjs|js)$/.test(path)))
		throw new MarketError(
			'missing-runtime-export',
			'The package must publish a JavaScript runtime export',
			422,
		)
	for (const path of targets) {
		if (!files.has(`package/${path}`))
			throw new MarketError('missing-export-file', `Public export file is missing: ${path}`, 422)
	}
	const pluginPackages: Record<string, 'required' | 'optional'> = {}
	if (object(manifest.pluxel) && manifest.pluxel.pluginPackages !== undefined) {
		const generated = manifest.pluxel.pluginPackages
		if (!object(generated) || Object.keys(generated).length > 200)
			throw new MarketError(
				'invalid-plugin-dependencies',
				'Invalid generated pluxel.pluginPackages',
				422,
			)
		for (const [name, mode] of Object.entries(generated)) {
			const optional =
				object(manifest.peerDependenciesMeta) &&
				object(manifest.peerDependenciesMeta[name]) &&
				manifest.peerDependenciesMeta[name].optional === true
			if (
				!peers[name] ||
				(mode !== 'required' && mode !== 'optional') ||
				optional !== (mode === 'optional') ||
				(object(manifest.dependencies) && Object.hasOwn(manifest.dependencies, name)) ||
				(object(manifest.optionalDependencies) &&
					Object.hasOwn(manifest.optionalDependencies, name))
			) {
				throw new MarketError(
					'invalid-plugin-dependencies',
					`Generated Plugin dependency ${name} disagrees with package peer declarations`,
					422,
				)
			}
			pluginPackages[name] = mode
		}
	}
	return {
		readme,
		license: typeof manifest.license === 'string' ? manifest.license.slice(0, 256) : null,
		repository: repositoryLink(manifest.repository),
		peerDependencies: peers,
		pluginPackages,
		description:
			typeof manifest.description === 'string' ? manifest.description.slice(0, 2000) : null,
	}
}

function repositoryLink(value: unknown): string | null {
	const raw = object(value) ? value.url : value
	if (typeof raw !== 'string' || raw.length > 2048) return null
	try {
		const url = new URL(raw.replace(/^git\+/, '').replace(/\.git$/, ''))
		return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
			? url.href.replace(/\/$/, '')
			: null
	} catch {
		return null
	}
}

/** Observe browsing metadata without accepting a release for installation. */
export async function fetchObservation(
	input: PackageIdentity,
	source: RegistrySource,
): Promise<Observation> {
	const observedAt = Date.now()
	const value = await npmJson(
		`${source.registry}/${encodeURIComponent(input.name)}`,
		source,
		AbortSignal.timeout(30_000),
		2 * 1024 * 1024,
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

export async function fetchRelease(
	input: Coordinate,
	source: RegistrySource,
): Promise<{ release: Release; observation: Observation }> {
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
		return await inspectRelease(input, source)
	} finally {
		activeRefreshes--
	}
}

async function inspectRelease(
	input: Coordinate,
	source: RegistrySource,
): Promise<{ release: Release; observation: Observation }> {
	const observedAt = Date.now()
	const signal = AbortSignal.timeout(30_000)
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
	const bytes = await npmBytes(tarball, source, signal, tarballBytes)
	const hash = new Uint8Array(await crypto.subtle.digest('SHA-512', bytes))
	const actual = `sha512-${btoa(String.fromCharCode(...hash))}`
	if (actual !== integrity)
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
	)
	if (
		!object(tags) ||
		Object.keys(tags).length > 100 ||
		Object.entries(tags).some(([tag, version]) => tag.length > 128 || !exactVersion(version))
	) {
		throw new MarketError('invalid-dist-tags', 'npm returned invalid or oversized dist-tags', 422)
	}
	return {
		release: {
			...input,
			tarball,
			integrity,
			checkedAt: Date.now(),
			provenance: { status: 'missing' },
			peerDependencies: facts.peerDependencies,
			pluginPackages: facts.pluginPackages,
			readme: facts.readme,
			license: facts.license,
		},
		observation: {
			description: facts.description,
			repository: facts.repository,
			metadataVersion: input.version,
			readme: facts.readme,
			license: facts.license,
			distTags: tags as Record<string, string>,
			observedAt,
		},
	}
}
