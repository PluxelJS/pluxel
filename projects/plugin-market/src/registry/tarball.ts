import { createTarDecoder } from 'modern-tar'
import semver from 'semver'
import {
	MarketError,
	object,
	packageName,
	readJson,
	type Coordinate,
	type Release,
} from '../protocol'

export const metadataBytes = 512 * 1024
const expandedBytes = 64 * 1024 * 1024
const maxFiles = 2048

export async function archiveIntegrity(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
	const hash = new Uint8Array(await crypto.subtle.digest('SHA-512', bytes))
	return `sha512-${btoa(String.fromCharCode(...hash))}`
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

export async function inspectTarball(bytes: Uint8Array<ArrayBuffer>, input: Coordinate) {
	let expanded = 0
	let fileCount = 0
	let unpackedBytes = 0
	let manifest: unknown
	let readme: Release['readme'] = null
	const files = new Set<string>()
	const paths = new Set<string>()
	const entries = new Response(bytes)
		.body!.pipeThrough(new DecompressionStream('gzip'))
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
			if (entry.header.type === 'file') {
				files.add(path)
				unpackedBytes += entry.header.size
			}
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
		manifest,
		archiveBytes: bytes.byteLength,
		unpackedBytes,
		readme,
		license: typeof manifest.license === 'string' ? manifest.license.slice(0, 256) : null,
		repository: repositoryLink(manifest.repository),
		peerDependencies: peers,
		pluginPackages,
		description:
			typeof manifest.description === 'string' ? manifest.description.slice(0, 2000) : null,
	}
}

export function repositoryLink(value: unknown): string | null {
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
