import * as v from 'valibot'
import { isPackageName } from './package-document.ts'
import {
	marketFilterLimit,
	publicRegistry,
	type MarketPackagePage,
	type MarketPackageDetail,
	type MarketPackageQuery,
	type MarketCatalogFacets,
	type MarketCatalogFilters,
	type MarketReadResult,
	type MarketRelease,
	type MarketReleasePage,
	type MarketReleaseQuery,
	type PackageMarket,
} from './market-contracts.ts'

const packageName = v.pipe(v.string(), v.check<string>(isPackageName))
const version = v.pipe(
	v.string(),
	v.maxLength(256),
	v.regex(
		/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/,
	),
)
const timestamp = v.pipe(v.number(), v.integer(), v.minValue(0))
const integrity = v.pipe(v.string(), v.regex(/^sha512-[A-Za-z0-9+/]{86}==$/))
export const defaultNpmMirrors = ['https://registry.npmmirror.com']
export const registrySchema = v.pipe(
	v.string(),
	v.maxLength(2048),
	v.check((input) => {
		try {
			const url = new URL(input)
			return (
				(url.protocol === 'https:' ||
					(url.protocol === 'http:' &&
						['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) &&
				!url.username &&
				!url.password &&
				!url.search &&
				!url.hash &&
				url.href.replace(/\/$/, '') === input
			)
		} catch {
			return false
		}
	}),
)
export const marketInstallRequestSchema = v.object({
	marketId: v.pipe(v.string(), v.regex(/^[a-zA-Z0-9_-]{1,64}$/)),
	registry: registrySchema,
	name: packageName,
	version,
})
const mark = v.pipe(v.string(), v.minLength(1), v.maxLength(64))
const taxonomySlug = v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9-]{0,31}$/))
const authorId = v.pipe(
	v.string(),
	v.regex(/^github:owner\/[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/),
)
const count = v.pipe(v.number(), v.integer(), v.minValue(0))
const safeLink = v.pipe(
	v.string(),
	v.maxLength(2048),
	v.check((input) => {
		try {
			const url = new URL(input)
			return url.protocol === 'https:' && !url.username && !url.password
		} catch {
			return false
		}
	}),
)
const avatar = v.pipe(safeLink, v.startsWith('https://avatars.githubusercontent.com/'))
const authorFields = {
	id: authorId,
	name: v.pipe(v.string(), v.regex(/^@[A-Za-z0-9-]{1,39}$/)),
	kind: v.literal('github'),
	avatarUrl: v.nullable(avatar),
}
function ownerMatchesName({ id, name }: { id: string; name: string }) {
	return id === 'github:owner/' + name.slice(1).toLowerCase()
}
function ownerMatchesRepository(pkg: Pick<MarketPackageDetail, 'author' | 'repository'>) {
	if (!pkg.author) return true
	const match = pkg.repository?.match(
		/^https:\/\/github\.com\/([a-z0-9-]+)\/([a-z0-9_.-]{1,100})$/i,
	)
	return Boolean(
		match &&
		match[2] !== '.' &&
		match[2] !== '..' &&
		pkg.author.id === 'github:owner/' + match[1].toLowerCase(),
	)
}
const packageFields = {
	registry: registrySchema,
	name: packageName,
	description: v.nullable(v.pipe(v.string(), v.maxLength(4096))),
	repository: v.nullable(safeLink),
	repositoryStars: v.nullable(v.pipe(v.number(), v.integer(), v.minValue(0))),
	repositoryObservedAt: v.nullable(timestamp),
	author: v.nullable(
		v.pipe(
			v.object(authorFields),
			v.check((owner) => ownerMatchesName(owner)),
		),
	),
	indexedVersions: count,
	observedAt: timestamp,
	official: v.boolean(),
	category: v.nullable(mark),
	tags: v.pipe(v.array(mark), v.maxLength(20)),
}
const facetsSchema = v.object({
	total: count,
	registries: v.array(v.object({ value: registrySchema, count })),
	categories: v.array(v.object({ value: taxonomySlug, count })),
	tags: v.array(v.object({ value: taxonomySlug, count })),
	authors: v.array(
		v.pipe(
			v.object({ ...authorFields, count }),
			v.check((owner) => ownerMatchesName(owner)),
		),
	),
})
const readme = v.nullable(
	v.object({ text: v.pipe(v.string(), v.maxLength(262_144)), truncated: v.boolean() }),
)
const license = v.nullable(v.pipe(v.string(), v.maxLength(256)))
const pageSchema = v.object({
	packages: v.pipe(
		v.array(
			v.pipe(
				v.object({ ...packageFields, latest: v.nullable(version) }),
				v.check((pkg) => ownerMatchesRepository(pkg)),
			),
		),
		v.maxLength(50),
	),
	nextCursor: v.nullable(v.pipe(v.string(), v.maxLength(2048))),
})
const requirementFields = {
	peerDependencies: v.record(packageName, v.pipe(v.string(), v.maxLength(512))),
	pluginPackages: v.record(packageName, v.picklist(['required', 'optional'])),
}
const packageSchema = v.pipe(
	v.object({
		...packageFields,
		latest: v.nullable(version),
		distTags: v.record(v.pipe(v.string(), v.maxLength(128)), version),
		metadataVersion: v.nullable(version),
		checkedRequirements: v.optional(v.object({ version, ...requirementFields })),
		readme,
		license,
		coverage: v.literal('indexed-only'),
	}),
	v.check((pkg) => ownerMatchesRepository(pkg)),
	v.check(
		(pkg) =>
			!pkg.checkedRequirements ||
			(pkg.indexedVersions > 0 && pkg.checkedRequirements.version === pkg.metadataVersion),
	),
)
const releaseSchema = v.object({
	name: packageName,
	version,
	registry: registrySchema,
	integrity,
	checkedAt: timestamp,
	provenance: v.variant('status', [
		v.object({ status: v.literal('missing') }),
		v.object({
			status: v.literal('verified'),
			repository: safeLink,
			commit: v.pipe(v.string(), v.maxLength(256)),
			buildUrl: v.nullable(safeLink),
		}),
	]),
	...requirementFields,
	readme,
	license,
})
const filterFields = {
	query: v.optional(v.pipe(v.string(), v.maxLength(100))),
	registries: v.optional(v.pipe(v.array(registrySchema), v.maxLength(marketFilterLimit))),
	official: v.optional(v.boolean()),
	categories: v.optional(v.pipe(v.array(taxonomySlug), v.maxLength(marketFilterLimit))),
	tags: v.optional(v.pipe(v.array(taxonomySlug), v.maxLength(marketFilterLimit))),
	authors: v.optional(v.pipe(v.array(authorId), v.maxLength(marketFilterLimit))),
}
const filterSchema = v.strictObject(filterFields)
const querySchema = v.strictObject({
	...filterFields,
	cursor: v.optional(v.pipe(v.string(), v.maxLength(2048))),
	limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(50))),
})

function catalogParams({
	query,
	registries,
	official,
	categories,
	tags,
	authors,
	cursor,
	limit,
}: MarketPackageQuery) {
	const params = new URLSearchParams()
	if (query !== undefined) params.set('query', query)
	if (official !== undefined) params.set('official', String(official))
	if (cursor !== undefined) params.set('cursor', cursor)
	if (limit !== undefined) params.set('limit', String(limit))
	for (const [key, values] of Object.entries({
		registry: registries,
		category: categories,
		tag: tags,
		author: authors,
	})) {
		for (const value of [...new Set(values)].sort()) params.append(key, value)
	}
	return params
}
const releaseQuerySchema = v.strictObject({
	registry: v.optional(registrySchema),
	cursor: v.optional(v.pipe(v.string(), v.maxLength(2048))),
	limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(50))),
})
const releasePageSchema = v.object({
	releases: v.pipe(
		v.array(v.object({ version, integrity, checkedAt: timestamp })),
		v.maxLength(100),
	),
	nextCursor: v.nullable(v.pipe(v.string(), v.maxLength(2048))),
	coverage: v.literal('indexed-only'),
})

export class PackageMarketClient {
	readonly markets: readonly PackageMarket[]
	private readonly lifetime = new AbortController()

	constructor(
		markets: readonly PackageMarket[],
		private readonly signal?: AbortSignal,
	) {
		const seen = new Set<string>()
		this.markets = Object.freeze(
			markets.map(({ id, url }) => {
				if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id) || seen.has(id))
					throw new TypeError('Market ids must be unique URL-safe names')
				seen.add(id)
				const parsed = new URL(url)
				if (
					!['http:', 'https:'].includes(parsed.protocol) ||
					parsed.username ||
					parsed.password ||
					parsed.search ||
					parsed.hash
				)
					throw new TypeError(
						'Market URLs must be HTTP(S) base URLs without credentials, query or fragment',
					)
				return Object.freeze({ id, url: parsed.href.replace(/\/$/, '') })
			}),
		)
	}

	close(): void {
		this.lifetime.abort(new Error('Package market client is closed'))
	}

	async packages(
		marketId: string,
		query: MarketPackageQuery = {},
	): Promise<MarketReadResult<MarketPackagePage>> {
		const parsed = v.safeParse(querySchema, query)
		if (!parsed.success)
			return rejected(
				'INVALID_QUERY',
				'Use a search up to 100 characters, up to 20 values per filter, an issued cursor and a limit from 1 to 50',
			)
		const { registries } = parsed.output
		const result = await this.read(
			marketId,
			`/v1/packages?${catalogParams(parsed.output)}`,
			pageSchema,
		)
		if (
			result.ok &&
			registries?.length &&
			result.value.packages.some((item) => !registries.includes(item.registry))
		)
			return rejected(
				'INVALID_RESPONSE',
				'Market returned packages outside the selected registries',
			)
		return result
	}

	async facets(
		marketId: string,
		filters: MarketCatalogFilters = {},
	): Promise<MarketReadResult<MarketCatalogFacets>> {
		const parsed = v.safeParse(filterSchema, filters)
		if (!parsed.success)
			return rejected(
				'INVALID_QUERY',
				'Use a search up to 100 characters and up to 20 values per filter',
			)
		return this.read(marketId, `/v1/facets?${catalogParams(parsed.output)}`, facetsSchema)
	}

	async package(
		marketId: string,
		name: string,
		selectedRegistry = publicRegistry,
	): Promise<MarketReadResult<MarketPackageDetail>> {
		if (
			!v.safeParse(packageName, name).success ||
			!v.safeParse(registrySchema, selectedRegistry).success
		)
			return rejected('INVALID_QUERY', 'Select a canonical registry and package name')
		const params = new URLSearchParams({ registry: selectedRegistry })
		const result = await this.read(
			marketId,
			`/v1/packages/${encodeURIComponent(name)}?${params}`,
			packageSchema,
		)
		if (result.ok && (result.value.name !== name || result.value.registry !== selectedRegistry))
			return rejected('INVALID_RESPONSE', 'Market returned a different registry or package')
		return result
	}

	async release(
		marketId: string,
		name: string,
		selectedVersion: string,
		selectedRegistry = publicRegistry,
	): Promise<MarketReadResult<MarketRelease>> {
		if (
			!v.safeParse(packageName, name).success ||
			!v.safeParse(version, selectedVersion).success ||
			!v.safeParse(registrySchema, selectedRegistry).success
		)
			return rejected(
				'INVALID_QUERY',
				'Select a canonical registry, package name and exact version',
			)
		const params = new URLSearchParams({ registry: selectedRegistry })
		const result = await this.read(
			marketId,
			`/v1/packages/${encodeURIComponent(name)}/releases/${encodeURIComponent(selectedVersion)}?${params}`,
			releaseSchema,
		)
		if (
			result.ok &&
			(result.value.name !== name ||
				result.value.version !== selectedVersion ||
				result.value.registry !== selectedRegistry)
		)
			return rejected(
				'INVALID_RESPONSE',
				'Market returned a different registry, package or version',
			)
		return result
	}

	async releases(
		marketId: string,
		name: string,
		query: MarketReleaseQuery = {},
	): Promise<MarketReadResult<MarketReleasePage>> {
		const parsed = v.safeParse(releaseQuerySchema, query)
		if (!v.safeParse(packageName, name).success || !parsed.success)
			return rejected(
				'INVALID_QUERY',
				'Use a canonical registry and package name, an issued cursor and limit between 1 and 50',
			)
		const params = new URLSearchParams()
		for (const [key, value] of Object.entries(parsed.output))
			if (value !== undefined) params.set(key, String(value))
		return this.read(
			marketId,
			`/v1/packages/${encodeURIComponent(name)}/releases?${params}`,
			releasePageSchema,
		)
	}

	private async read<T>(
		marketId: string,
		path: string,
		schema: v.GenericSchema<unknown, T>,
	): Promise<MarketReadResult<T>> {
		this.lifetime.signal.throwIfAborted()
		this.signal?.throwIfAborted()
		const market = this.markets.find((item) => item.id === marketId)
		if (!market) return rejected('UNKNOWN_MARKET', 'Market is not configured')
		const signal = AbortSignal.any([
			this.lifetime.signal,
			...(this.signal ? [this.signal] : []),
			AbortSignal.timeout(10_000),
		])
		let response: Response
		try {
			response = await fetch(market.url + path, {
				headers: { accept: 'application/json' },
				credentials: 'omit',
				redirect: 'error',
				signal,
			})
		} catch {
			this.lifetime.signal.throwIfAborted()
			this.signal?.throwIfAborted()
			return rejected('MARKET_UNAVAILABLE', 'Market request failed or timed out')
		}
		if (!response.ok) {
			await response.body?.cancel()
			const notIndexed = response.status === 404 && path.startsWith('/v1/packages/')
			return rejected(
				notIndexed ? 'NOT_INDEXED' : 'MARKET_UNAVAILABLE',
				notIndexed
					? 'This package or release is not indexed by the market'
					: `Market returned HTTP ${response.status}`,
			)
		}
		try {
			const reader = response.body?.getReader()
			if (!reader) return rejected('INVALID_RESPONSE', 'Market response is empty')
			const chunks: Uint8Array[] = []
			let size = 0
			try {
				for (;;) {
					const chunk = await reader.read()
					if (chunk.done) break
					size += chunk.value.length
					if (size > 1_048_576) {
						await reader.cancel()
						return rejected('INVALID_RESPONSE', 'Market response exceeds the size limit')
					}
					chunks.push(chunk.value)
				}
			} finally {
				reader.releaseLock()
			}
			const bytes = new Uint8Array(size)
			let offset = 0
			for (const chunk of chunks) {
				bytes.set(chunk, offset)
				offset += chunk.length
			}
			const parsed = v.safeParse(schema, JSON.parse(new TextDecoder().decode(bytes)))
			if (!parsed.success)
				return rejected(
					'INVALID_RESPONSE',
					'Market response does not match the public package protocol',
				)
			this.lifetime.signal.throwIfAborted()
			this.signal?.throwIfAborted()
			return { ok: true, value: parsed.output }
		} catch {
			this.lifetime.signal.throwIfAborted()
			this.signal?.throwIfAborted()
			return rejected('INVALID_RESPONSE', 'Market response could not be read as bounded JSON')
		}
	}
}

function rejected(
	code: Extract<MarketReadResult<never>, { ok: false }>['error']['code'],
	message: string,
): MarketReadResult<never> {
	return { ok: false, error: { code, message } }
}
