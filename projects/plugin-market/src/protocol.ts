import semver from 'semver'
import validatePackageName from 'validate-npm-package-name'

export const registry = 'https://registry.npmjs.org' as const

export type PackageIdentity = { registry: string; name: string }
export type Coordinate = PackageIdentity & { version: string }

export type MarketCuration = { official: boolean; category: string | null; tags: string[] }

/** Owner of the declared GitHub repository; the release carries its own publisher evidence. */
export type MarketAuthor = {
	id: string
	name: string
	kind: 'github'
	avatarUrl: string | null
}

export type CatalogFilters = {
	query?: string
	registries?: string[]
	official?: boolean
	categories?: string[]
	tags?: string[]
	authors?: string[]
}

export type PackageQuery = CatalogFilters & {
	cursor?: string
	limit?: number
}

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
	readme: { text: string; truncated: boolean } | null
	license: string | null
}

export type PackageSummary = {
	registry: string
	name: string
	description: string | null
	latest: string | null
	repository: string | null
	repositoryStars: number | null
	repositoryObservedAt: number | null
	author: MarketAuthor | null
	indexedVersions: number
	observedAt: number
} & MarketCuration

export type PackagePage = { packages: PackageSummary[]; nextCursor: string | null }

type FacetValue = { value: string; count: number }

export type CatalogFacets = {
	total: number
	registries: FacetValue[]
	categories: FacetValue[]
	tags: FacetValue[]
	authors: (MarketAuthor & { count: number })[]
}

export type Receipt = Coordinate & {
	id: string
	status: 'pending' | 'processing' | 'indexed' | 'failed'
	attempts: number
	createdAt: number
	updatedAt: number
	nextAttemptAt: number | null
	code: string | null
}

export type NotificationQuery = {
	registry?: string
	name?: string
	status?: Receipt['status']
	code?: string
	cursor?: string
	limit?: number
}

export type GitHubNotificationPublisher = { workflowRef: string; runId: string; runAttempt: string }

export type NotificationDetail = Receipt & {
	diagnostic: string | null
	githubPublisher: GitHubNotificationPublisher | null
	retry: 'available' | 'not-failed' | 'attempts-exhausted' | 'provenance-runtime-unsupported'
}

export class MarketError extends Error {
	readonly code: string
	readonly status: number
	readonly retryable: boolean
	constructor(code: string, message: string, status = 400, retryable = false) {
		super(message)
		this.name = 'MarketError'
		this.code = code
		this.status = status
		this.retryable = retryable
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
		typeof value.registry !== 'string' ||
		!packageName(value.name) ||
		!exactVersion(value.version) ||
		Object.keys(value).length !== 3
	) {
		throw new MarketError(
			'invalid-coordinate',
			'Expected a configured registry, a package name and an exact version',
		)
	}
	return { registry: registryBase(value.registry), name: value.name, version: value.version }
}

/** Canonical registry identity: no trailing slash; a path prefix is allowed. */
export function registryBase(value: string): string {
	let url: URL
	try {
		url = new URL(value)
	} catch {
		throw new MarketError('invalid-registry', 'Expected an absolute registry base URL')
	}
	if (
		(url.protocol !== 'https:' &&
			!(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		url.pathname.includes('%') ||
		/\/\//.test(url.pathname)
	)
		throw new MarketError(
			'invalid-registry',
			'Registry URLs require HTTPS (or loopback HTTP), without credentials, query or fragment',
		)
	return url.href.replace(/\/$/, '')
}

export function taxonomySlug(value: unknown): value is string {
	return typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,31}$/.test(value)
}

const githubLogin = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/i
export const repositoryOwnerIdPrefix = 'github:owner/'

export function catalogAuthorId(value: string): boolean {
	if (!value.startsWith(repositoryOwnerIdPrefix)) return false
	const login = value.slice(repositoryOwnerIdPrefix.length)
	return login === login.toLowerCase() && githubLogin.test(login)
}

/** Input is the normalized repository link stored by observe/refresh. */
export function repositoryOwner(repository: string | null): string | null {
	const parts = /^https:\/\/github\.com\/([^/]+)\/([A-Za-z0-9_.-]{1,100})$/.exec(repository ?? '')
	if (!parts || !githubLogin.test(parts[1]) || parts[2] === '.' || parts[2] === '..') return null
	return parts[1]
}

export function repositoryAuthor(owner: string, avatarUrl: string | null): MarketAuthor {
	return {
		id: repositoryOwnerIdPrefix + owner.toLowerCase(),
		name: '@' + owner,
		kind: 'github',
		avatarUrl,
	}
}

export function pageLimit(value: unknown = 20): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 50)
		throw new MarketError('invalid-limit', 'limit must be an integer from 1 to 50')
	return value
}

export function encodeCursor(scope: string, after: unknown): string {
	return btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify({ scope, after }))))
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replaceAll('=', '')
}

export function decodeCursor(raw: string | undefined, scope: string): unknown {
	if (raw === undefined) return null
	try {
		if (typeof raw !== 'string' || raw.length > 4096 || !/^[\w-]+$/.test(raw))
			throw new Error('Invalid cursor')
		const value: unknown = JSON.parse(
			new TextDecoder('utf-8', { fatal: true }).decode(
				Uint8Array.from(atob(raw.replaceAll('-', '+').replaceAll('_', '/')), (character) =>
					character.charCodeAt(0),
				),
			),
		)
		if (!object(value) || value.scope !== scope || Object.keys(value).length !== 2)
			throw new Error('Mismatched query')
		return value.after
	} catch {
		throw new MarketError('invalid-cursor', 'Invalid cursor or changed query; restart the query')
	}
}

export function packageIdentity(value: unknown): PackageIdentity {
	if (
		!object(value) ||
		typeof value.registry !== 'string' ||
		!packageName(value.name) ||
		Object.keys(value).length !== 2
	)
		throw new MarketError('invalid-package', 'Expected registry and canonical package name')
	return { registry: registryBase(value.registry), name: value.name }
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
