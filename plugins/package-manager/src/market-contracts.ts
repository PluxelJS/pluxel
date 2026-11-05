export type PackageMarket = Readonly<{ id: string; url: string }>

export type MarketPackageQuery = Readonly<{
	query?: string
	registry?: string
	official?: boolean
	category?: string
	tag?: string
	cursor?: string
	limit?: number
}>
export type MarketReleaseQuery = Readonly<{ registry?: string; cursor?: string; limit?: number }>
export type MarketPackageSummary = Readonly<{
	registry: string
	name: string
	description: string | null
	latest: string | null
	/** Declared HTTPS repository URL; independent of build provenance. */
	repository: string | null
	/** Last observed source-repository stars; null means no observation is available. */
	repositoryStars: number | null
	repositoryObservedAt: number | null
	indexedVersions: number
	observedAt: number
	/** Market-administered marks, independent of the release's build provenance. */
	official: boolean
	category: string | null
	tags: readonly string[]
}>
export type MarketPackagePage = Readonly<{
	packages: readonly MarketPackageSummary[]
	nextCursor: string | null
}>
/** Registry metadata can be browsed before any installable release has been checked. */
export type MarketPackageDetail = MarketPackageSummary &
	Readonly<{
		distTags: Readonly<Record<string, string>>
		metadataVersion: string | null
		/** Package-level README reported by the registry, not checked archive contents. */
		readme: Readonly<{ text: string; truncated: boolean }> | null
		license: string | null
		coverage: 'indexed-only'
	}>
export type MarketReleasePage = Readonly<{
	releases: readonly Readonly<{ version: string; integrity: string; checkedAt: number }>[]
	nextCursor: string | null
	/** This is the indexed subset, not a complete npm version history. */
	coverage: 'indexed-only'
}>
export type MarketRelease = Readonly<{
	name: string
	version: string
	registry: string
	integrity: string
	checkedAt: number
	provenance:
		| Readonly<{ status: 'missing' }>
		| Readonly<{ status: 'verified'; repository: string; commit: string; buildUrl: string | null }>
	peerDependencies: Readonly<Record<string, string>>
	pluginPackages: Readonly<Record<string, 'required' | 'optional'>>
	/** README read from this checked release's package archive. */
	readme: Readonly<{ text: string; truncated: boolean }> | null
	license: string | null
}>
export type MarketReadResult<T> =
	| Readonly<{ ok: true; value: T }>
	| Readonly<{
			ok: false
			error: Readonly<{
				code: 'UNKNOWN_MARKET' | 'INVALID_QUERY' | 'MARKET_UNAVAILABLE' | 'INVALID_RESPONSE'
				message: string
			}>
	  }>
export type MarketPackageIdentity = Readonly<{ registry: string; name: string }>
export type MarketReleaseIdentity = MarketPackageIdentity & Readonly<{ version: string }>
export type MarketInstallRequest = MarketReleaseIdentity & Readonly<{ marketId: string }>
