import * as v from 'valibot'
import type {
	MarketPackagePage,
	MarketPackageDetail,
	MarketPackageQuery,
	MarketReadResult,
	MarketRelease,
	MarketReleasePage,
	MarketReleaseQuery,
	PackageMarket,
} from './market-contracts.ts'

const packageName = v.pipe(
	v.string(),
	v.maxLength(214),
	v.regex(/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/),
)
const version = v.pipe(
	v.string(),
	v.maxLength(256),
	v.regex(
		/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/,
	),
)
const timestamp = v.pipe(v.number(), v.integer(), v.minValue(0))
const integrity = v.pipe(v.string(), v.regex(/^sha512-[A-Za-z0-9+/]{86}==$/))
const publicRegistry = 'https://registry.npmjs.org'
const registry = v.pipe(
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
const mark = v.pipe(v.string(), v.minLength(1), v.maxLength(64))
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
const packageFields = {
	registry,
	name: packageName,
	description: v.nullable(v.pipe(v.string(), v.maxLength(4096))),
	repository: v.nullable(safeLink),
	repositoryStars: v.nullable(v.pipe(v.number(), v.integer(), v.minValue(0))),
	repositoryObservedAt: v.nullable(timestamp),
	indexedVersions: v.pipe(v.number(), v.integer(), v.minValue(0)),
	observedAt: timestamp,
	official: v.boolean(),
	category: v.nullable(mark),
	tags: v.pipe(v.array(mark), v.maxLength(20)),
}
const readme = v.nullable(
	v.object({ text: v.pipe(v.string(), v.maxLength(262_144)), truncated: v.boolean() }),
)
const license = v.nullable(v.pipe(v.string(), v.maxLength(256)))
const pageSchema = v.object({
	packages: v.pipe(
		v.array(v.object({ ...packageFields, latest: v.nullable(version) })),
		v.maxLength(50),
	),
	nextCursor: v.nullable(v.pipe(v.string(), v.maxLength(2048))),
})
const packageSchema = v.object({
	...packageFields,
	latest: v.nullable(version),
	distTags: v.record(v.pipe(v.string(), v.maxLength(128)), version),
	metadataVersion: v.nullable(version),
	readme,
	license,
	coverage: v.literal('indexed-only'),
})
const releaseSchema = v.object({
	name: packageName,
	version,
	registry,
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
	peerDependencies: v.record(packageName, v.pipe(v.string(), v.maxLength(512))),
	pluginPackages: v.record(packageName, v.picklist(['required', 'optional'])),
	readme,
	license,
})
const querySchema = v.strictObject({
	query: v.optional(v.pipe(v.string(), v.maxLength(100))),
	registry: v.optional(registry),
	official: v.optional(v.boolean()),
	category: v.optional(mark),
	tag: v.optional(mark),
	cursor: v.optional(v.pipe(v.string(), v.maxLength(2048))),
	limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(50))),
})
const releaseQuerySchema = v.strictObject({
	registry: v.optional(registry),
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
				'Use a search up to 100 characters, canonical registry, market marks, an issued cursor and limit between 1 and 50',
			)
		const params = new URLSearchParams()
		for (const [key, value] of Object.entries(parsed.output))
			if (value !== undefined) params.set(key, String(value))
		const result = await this.read(marketId, `/v1/packages?${params}`, pageSchema)
		if (
			result.ok &&
			parsed.output.registry !== undefined &&
			result.value.packages.some((item) => item.registry !== parsed.output.registry)
		)
			return rejected('INVALID_RESPONSE', 'Market returned packages from a different registry')
		return result
	}

	async package(
		marketId: string,
		name: string,
		selectedRegistry = publicRegistry,
	): Promise<MarketReadResult<MarketPackageDetail>> {
		if (!v.safeParse(packageName, name).success || !v.safeParse(registry, selectedRegistry).success)
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
			!v.safeParse(registry, selectedRegistry).success
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
				redirect: 'error',
				signal,
			})
		} catch {
			this.lifetime.signal.throwIfAborted()
			this.signal?.throwIfAborted()
			return rejected(
				'MARKET_UNAVAILABLE',
				'Market request failed or timed out; direct installation remains available',
			)
		}
		if (!response.ok) {
			await response.body?.cancel()
			return rejected(
				'MARKET_UNAVAILABLE',
				response.status === 404
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
