import semver from 'semver'
import validatePackageName from 'validate-npm-package-name'

export const registry = 'https://registry.npmjs.org' as const

export type Coordinate = { registry: typeof registry; name: string; version: string }

export type Provenance =
	| { status: 'missing' }
	| { status: 'verified'; repository: string; commit: string; buildUrl: string | null }

export type Release = Coordinate & {
	tarball: string
	integrity: string
	checkedAt: number
	provenance: Provenance
	peerDependencies: Record<string, string>
	pluginPackages: Record<string, 'required' | 'optional'>
}

export type PackageSummary = {
	name: string
	description: string | null
	latest: string | null
	repository: string | null
	indexedVersions: number
	observedAt: number
}

export type PackagePage = { packages: PackageSummary[]; nextCursor: string | null }

export type Receipt = Coordinate & {
	id: string
	status: 'pending' | 'processing' | 'indexed' | 'failed'
	attempts: number
	createdAt: number
	updatedAt: number
	nextAttemptAt: number | null
	code: string | null
}

export class MarketError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly status = 400,
		readonly retryable = false,
	) {
		super(message)
		this.name = 'MarketError'
	}
}

export function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function packageName(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length <= 214 &&
		validatePackageName(value).validForNewPackages
	)
}

export function exactVersion(value: unknown): value is string {
	return typeof value === 'string' && value.length <= 128 && semver.valid(value) === value
}

export function coordinate(value: unknown): Coordinate {
	if (
		!object(value) ||
		value.registry !== registry ||
		!packageName(value.name) ||
		!exactVersion(value.version) ||
		Object.keys(value).length !== 3
	) {
		throw new MarketError(
			'invalid-coordinate',
			'Expected the public npm registry, a package name and an exact version',
		)
	}
	return { registry, name: value.name, version: value.version }
}

export async function readBytes(
	body: ReadableStream<Uint8Array> | null,
	limit: number,
): Promise<Uint8Array<ArrayBuffer>> {
	if (!body) throw new MarketError('missing-body', 'Expected a response body', 502, true)
	const reader = body.getReader()
	const chunks: Uint8Array[] = []
	let size = 0
	try {
		for (;;) {
			const chunk = await reader.read()
			if (chunk.done) break
			size += chunk.value.byteLength
			if (size > limit)
				throw new MarketError('size-limit', 'The input exceeds the allowed byte limit', 413)
			chunks.push(chunk.value)
		}
	} catch (error) {
		await reader.cancel(error).catch(() => {})
		throw error
	} finally {
		reader.releaseLock()
	}
	const bytes = new Uint8Array(size)
	let offset = 0
	for (const chunk of chunks) {
		bytes.set(chunk, offset)
		offset += chunk.byteLength
	}
	return bytes
}

export async function readJson(
	body: ReadableStream<Uint8Array> | null,
	limit: number,
): Promise<unknown> {
	const bytes = await readBytes(body, limit)
	try {
		return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
	} catch {
		throw new MarketError('invalid-json', 'Expected UTF-8 JSON')
	}
}
