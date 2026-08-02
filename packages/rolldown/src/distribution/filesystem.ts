import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readdir, readlink, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

import type { DistributionDifference, DistributionEntry } from './types'

export const DISTRIBUTION_MANIFEST_FILE = 'pluxel-distribution.json'
export const DISTRIBUTION_ENVELOPE_FILE = 'pluxel-distribution.dsse.json'
export const DELIVERY_MARKER_FILE = 'pluxel-delivery.json'

const EXCLUDED_ROOT_FILES = new Set([DISTRIBUTION_MANIFEST_FILE, DISTRIBUTION_ENVELOPE_FILE])
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const DRIVE_PREFIX = /^[A-Za-z]:/

export class DistributionFilesystemError extends Error {
	override readonly name = 'DistributionFilesystemError'

	constructor(
		message: string,
		readonly path: string,
	) {
		super(message)
	}
}

export async function collectDistributionEntries(rootInput: string): Promise<DistributionEntry[]> {
	const root = resolve(rootInput)
	const rootStat = await lstat(root)
	if (!rootStat.isDirectory()) {
		throw new DistributionFilesystemError('distribution root must be a directory', '.')
	}
	const realRoot = await realpath(root)
	const entries: DistributionEntry[] = []
	const normalizedPaths = new Map<string, string>()
	const foldedPaths = new Map<string, string>()
	const queue: Array<{ rawDirectory: string; rawSegments: string[] }> = [
		{ rawDirectory: root, rawSegments: [] },
	]

	for (let directoryIndex = 0; directoryIndex < queue.length; directoryIndex++) {
		const current = queue[directoryIndex]!
		const children = await readdir(current.rawDirectory, { withFileTypes: true })
		children.sort((left, right) => compareUtf8(left.name, right.name))
		for (const child of children) {
			if (current.rawSegments.length === 0 && EXCLUDED_ROOT_FILES.has(child.name)) continue
			const rawSegments = [...current.rawSegments, child.name]
			const manifestPath = normalizeEntryPath(rawSegments)
			registerPortablePath(manifestPath, rawSegments.join('/'), normalizedPaths, foldedPaths)
			const rawPath = resolve(current.rawDirectory, child.name)

			if (child.isDirectory()) {
				queue.push({ rawDirectory: rawPath, rawSegments })
				continue
			}
			if (child.isFile()) {
				const metadata = await lstat(rawPath)
				entries.push({
					path: manifestPath,
					type: 'file',
					size: metadata.size,
					sha256: await sha256File(rawPath),
				})
				continue
			}
			if (child.isSymbolicLink()) {
				const target = normalizeSymlinkTarget(await readlink(rawPath), manifestPath)
				await assertSafeSymlink(root, realRoot, rawPath, target, manifestPath)
				entries.push({ path: manifestPath, type: 'symlink', target })
				continue
			}
			throw new DistributionFilesystemError(
				`unsupported filesystem entry at ${manifestPath}`,
				manifestPath,
			)
		}
	}

	return entries.sort((left, right) => compareUtf8(left.path, right.path))
}

export function compareDistributionEntries(
	expected: readonly DistributionEntry[],
	observed: readonly DistributionEntry[],
): DistributionDifference[] {
	const expectedByPath = new Map(expected.map((entry) => [entry.path, entry]))
	const observedByPath = new Map(observed.map((entry) => [entry.path, entry]))
	const paths = [...new Set([...expectedByPath.keys(), ...observedByPath.keys()])].sort(compareUtf8)
	const differences: DistributionDifference[] = []

	for (const path of paths) {
		const wanted = expectedByPath.get(path)
		const actual = observedByPath.get(path)
		if (!wanted) {
			differences.push({ kind: 'unexpected', path })
			continue
		}
		if (!actual) {
			differences.push({ kind: 'missing', path })
			continue
		}
		if (wanted.type !== actual.type) {
			differences.push({ kind: 'changed', path, expected: wanted.type, observed: actual.type })
			continue
		}
		if (wanted.type === 'file' && actual.type === 'file') {
			if (wanted.size !== actual.size || wanted.sha256 !== actual.sha256) {
				differences.push({
					kind: 'changed',
					path,
					expected: `${wanted.size}:${wanted.sha256}`,
					observed: `${actual.size}:${actual.sha256}`,
				})
			}
			continue
		}
		if (wanted.type === 'symlink' && actual.type === 'symlink' && wanted.target !== actual.target) {
			differences.push({
				kind: 'symlink-target',
				path,
				expected: wanted.target,
				observed: actual.target,
			})
		}
	}
	return differences
}

export function validateManifestEntry(entry: unknown, label: string): DistributionEntry {
	const value = readExactRecord(entry, label)
	const type = value.type
	const path = readManifestPath(value.path, `${label}.path`)
	if (type === 'file') {
		assertExactFields(value, ['path', 'type', 'size', 'sha256'], label)
		if (!Number.isSafeInteger(value.size) || Number(value.size) < 0) {
			throw new TypeError(`${label}.size must be a non-negative safe integer`)
		}
		if (typeof value.sha256 !== 'string' || !SHA256_PATTERN.test(value.sha256)) {
			throw new TypeError(`${label}.sha256 must be a lowercase SHA-256 digest`)
		}
		return { path, type, size: Number(value.size), sha256: value.sha256 }
	}
	if (type === 'symlink') {
		assertExactFields(value, ['path', 'type', 'target'], label)
		if (typeof value.target !== 'string') throw new TypeError(`${label}.target must be a string`)
		return { path, type, target: normalizeSymlinkTarget(value.target, path) }
	}
	throw new TypeError(`${label}.type must be "file" or "symlink"`)
}

export function assertSortedUniqueEntries(entries: readonly DistributionEntry[]): void {
	for (let index = 0; index < entries.length; index++) {
		const previous = entries[index - 1]
		const current = entries[index]!
		if (previous && compareUtf8(previous.path, current.path) >= 0) {
			throw new TypeError('distribution entries must be unique and sorted by UTF-8 path bytes')
		}
	}
}

export function readExactRecord(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new TypeError(`${label} must be an object`)
	}
	const prototype = Object.getPrototypeOf(value)
	if (prototype !== Object.prototype && prototype !== null) {
		throw new TypeError(`${label} must be a plain object`)
	}
	for (const [field, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
		if (!('value' in descriptor)) throw new TypeError(`${label}.${field} must be a data property`)
	}
	if (Object.getOwnPropertySymbols(value).length > 0) {
		throw new TypeError(`${label} must not contain symbol fields`)
	}
	return value as Record<string, unknown>
}

export function assertExactFields(
	value: Record<string, unknown>,
	fields: readonly string[],
	label: string,
): void {
	const allowed = new Set(fields)
	const actual = Object.getOwnPropertyNames(value)
	const unknown = actual.filter((field) => !allowed.has(field))
	const missing = fields.filter((field) => !Object.hasOwn(value, field))
	if (unknown.length > 0) throw new TypeError(`${label} contains unsupported field ${unknown[0]}`)
	if (missing.length > 0) throw new TypeError(`${label} is missing field ${missing[0]}`)
}

export function compareUtf8(left: string, right: string): number {
	return Buffer.compare(Buffer.from(left), Buffer.from(right))
}

export function isPathInside(rootInput: string, candidateInput: string): boolean {
	const root = resolve(rootInput)
	const candidate = resolve(candidateInput)
	const child = relative(root, candidate)
	return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))
}

async function sha256File(path: string): Promise<string> {
	const hash = createHash('sha256')
	for await (const chunk of createReadStream(path)) hash.update(chunk)
	return hash.digest('hex')
}

function normalizeEntryPath(rawSegments: readonly string[]): string {
	const segments = rawSegments.map((segment) => {
		if (!segment || segment === '.' || segment === '..' || segment.includes('\0')) {
			throw new DistributionFilesystemError(
				'invalid distribution path segment',
				rawSegments.join('/'),
			)
		}
		if (segment.includes('\\')) {
			throw new DistributionFilesystemError(
				'distribution paths must not contain backslashes',
				rawSegments.join('/'),
			)
		}
		return segment.normalize('NFC')
	})
	return readManifestPath(segments.join('/'), 'distribution path')
}

function readManifestPath(value: unknown, label: string): string {
	if (typeof value !== 'string' || value.length === 0)
		throw new TypeError(`${label} must be a non-empty string`)
	if (
		value.includes('\0') ||
		value.includes('\\') ||
		value.startsWith('/') ||
		DRIVE_PREFIX.test(value) ||
		value.normalize('NFC') !== value
	) {
		throw new TypeError(`${label} must be a normalized relative NFC path`)
	}
	const segments = value.split('/')
	if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
		throw new TypeError(`${label} contains an invalid path segment`)
	}
	return value
}

function normalizeSymlinkTarget(value: string, path: string): string {
	if (
		!value ||
		value.includes('\0') ||
		value.includes('\\') ||
		value.startsWith('/') ||
		DRIVE_PREFIX.test(value) ||
		value.normalize('NFC') !== value
	) {
		throw new DistributionFilesystemError(
			'symlink target must be a normalized relative NFC path',
			path,
		)
	}
	if (value.split('/').some((segment) => segment.length === 0)) {
		throw new DistributionFilesystemError('symlink target contains an empty path segment', path)
	}
	return value
}

function registerPortablePath(
	path: string,
	rawPath: string,
	normalizedPaths: Map<string, string>,
	foldedPaths: Map<string, string>,
): void {
	const normalizedCollision = normalizedPaths.get(path)
	if (normalizedCollision !== undefined) {
		throw new DistributionFilesystemError(
			`distribution paths collide after NFC normalization: ${normalizedCollision} and ${rawPath}`,
			path,
		)
	}
	normalizedPaths.set(path, rawPath)
	const folded = path.toLowerCase()
	const foldedCollision = foldedPaths.get(folded)
	if (foldedCollision !== undefined) {
		throw new DistributionFilesystemError(
			`distribution paths are not portable across case-insensitive filesystems: ${foldedCollision} and ${path}`,
			path,
		)
	}
	foldedPaths.set(folded, path)
}

async function assertSafeSymlink(
	root: string,
	realRoot: string,
	linkPath: string,
	target: string,
	manifestPath: string,
): Promise<void> {
	const targetPath = resolve(dirname(linkPath), target)
	if (!isPathInside(root, targetPath)) {
		throw new DistributionFilesystemError(
			'symlink target escapes the distribution root',
			manifestPath,
		)
	}
	if (isPathInside(targetPath, linkPath)) {
		throw new DistributionFilesystemError('symlink cycle is not allowed', manifestPath)
	}
	try {
		const resolvedTarget = await realpath(targetPath)
		if (!isPathInside(realRoot, resolvedTarget)) {
			throw new DistributionFilesystemError(
				'symlink resolves outside the distribution root',
				manifestPath,
			)
		}
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code
		if (code === 'ELOOP') {
			throw new DistributionFilesystemError('symlink cycle is not allowed', manifestPath)
		}
		if (code !== 'ENOENT') throw error
		let existing = dirname(targetPath)
		while (isPathInside(root, existing)) {
			try {
				const resolvedParent = await realpath(existing)
				if (!isPathInside(realRoot, resolvedParent)) {
					throw new DistributionFilesystemError(
						'symlink resolves through a directory outside the distribution root',
						manifestPath,
					)
				}
				return
			} catch (parentError) {
				if ((parentError as NodeJS.ErrnoException).code !== 'ENOENT') throw parentError
			}
			const parent = dirname(existing)
			if (parent === existing) break
			existing = parent
		}
		throw new DistributionFilesystemError('symlink target cannot be resolved safely', manifestPath)
	}
}
