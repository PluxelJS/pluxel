import {
	useCallback,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type ReactNode,
	type ComponentType,
} from 'react'
import {
	marketFilterLimit,
	type MarketCatalogFacets,
	type MarketCatalogFilters,
	type MarketPackageIdentity,
	type MarketPackageQuery,
	type MarketPackageSummary,
	type MarketPackageDetail,
	type MarketPackagePage,
	type MarketReleaseIdentity,
	type MarketReleaseQuery,
	type MarketRelease,
	type MarketReleasePage,
	type MarketReadResult,
} from '../market-contracts.ts'
import {
	AuthorAvatar,
	CatalogFilters,
	catalogFacets,
	categoryLabel,
	emptySelection,
	registryLabel,
	type CatalogFacet,
	type CatalogSelection,
} from './marketplace-filters.tsx'
import { marketplaceStyles } from './marketplace.styles.ts'
import { Readme } from './marketplace-readme.tsx'

/** One read owned by the host. Refresh errors may accompany the last successful data. */
export type MarketplaceRead<T> = Readonly<{
	data?: MarketReadResult<T>
	error?: unknown
	isFetching: boolean
	refetch(): Promise<unknown>
}>

type ReadChildren<T> = Readonly<{ children(read: MarketplaceRead<T>): ReactNode }>

/** Stable read components bound to one market; the host owns transport, caching and cleanup.
 * Render children with the current read state. Identity changes must not expose old results.
 * Keep these component types stable. Changing market requires a new Marketplace React key.
 */
export type MarketplaceData = Readonly<{
	Packages: ComponentType<ReadChildren<MarketPackagePage> & Readonly<{ query: MarketPackageQuery }>>
	Facets: ComponentType<
		ReadChildren<MarketCatalogFacets> & Readonly<{ filters: MarketCatalogFilters }>
	>
	Package: ComponentType<
		ReadChildren<MarketPackageDetail> & Readonly<{ identity: MarketPackageIdentity }>
	>
	Releases: ComponentType<
		ReadChildren<MarketReleasePage> &
			Readonly<{ identity: MarketPackageIdentity; query: MarketReleaseQuery }>
	>
	Release: ComponentType<
		ReadChildren<MarketRelease> & Readonly<{ identity: MarketReleaseIdentity }>
	>
}>

export type MarketplaceProps = Readonly<{
	data: MarketplaceData
	/** Omit in a browsing-only host. Called only for a checked exact release. */
	onPrepare?(selection: MarketReleaseIdentity): void
	busy?: boolean
	/** Fixed appearance for this surface. @defaultValue 'light' */
	colorScheme?: 'light' | 'dark'
}>

type BrowseProps = Pick<MarketplaceProps, 'data' | 'onPrepare' | 'busy'>

export function Marketplace({ colorScheme = 'light', ...props }: MarketplaceProps) {
	return (
		<section
			className="plx-marketplace"
			data-color-scheme={colorScheme}
			aria-label="Plugin marketplace"
		>
			<style>{marketplaceStyles}</style>
			<MarketPackages {...props} />
		</section>
	)
}

function MarketPackages({ data, busy, onPrepare }: BrowseProps) {
	const [query, setQuery] = useState('')
	const [selection, setSelection] = useState(emptySelection)
	const [official, setOfficial] = useState<boolean>()
	const [cursors, setCursors] = useState<string[]>([])
	const [selectedPackage, setSelectedPackage] = useState<MarketPackageSummary>()
	const catalog = useRef<HTMLDivElement>(null)
	const details = useRef<HTMLDivElement>(null)
	const searchInput = useRef<HTMLInputElement>(null)
	const returnTo = useRef<{ button: HTMLButtonElement; scroll: Element | null; top: number }>(
		undefined,
	)
	const cursor = cursors.at(-1)
	const filters = useMemo<MarketCatalogFilters>(() => {
		const selected: Partial<Record<CatalogFacet, readonly string[]>> = {}
		for (const facet of catalogFacets) {
			if (selection[facet].length > 0)
				selected[facet] = selection[facet].map(({ value }) => value).sort()
		}
		return {
			...selected,
			...(query ? { query } : {}),
			...(official !== undefined ? { official } : {}),
		}
	}, [query, official, selection])
	const pageQuery = useMemo(
		() => ({
			...filters,
			limit: 30,
			...(cursor ? { cursor } : {}),
		}),
		[filters, cursor],
	)

	const scrollToCatalog = useCallback(() => {
		catalog.current?.scrollIntoView?.({ block: 'start', inline: 'nearest' })
	}, [])
	const restart = useCallback(() => {
		setCursors([])
		scrollToCatalog()
	}, [scrollToCatalog])
	const applyQuery = useCallback(
		(value: string) => {
			setQuery(value)
			restart()
		},
		[restart],
	)
	const toggle = (facet: CatalogFacet, choice: CatalogSelection[CatalogFacet][number]) => {
		setSelection((current) => {
			const values = current[facet]
			const matches = values.some(({ value }) => value === choice.value)
			if (!matches && values.length >= marketFilterLimit) return current
			return {
				...current,
				[facet]: matches
					? values.filter(({ value }) => value !== choice.value)
					: [...values, choice],
			}
		})
		restart()
	}
	const openPackage = (pkg: MarketPackageSummary, button: HTMLButtonElement) => {
		const scroll = scrollContainer(button)
		returnTo.current = { button, scroll, top: scroll?.scrollTop ?? 0 }
		setSelectedPackage(pkg)
	}

	useLayoutEffect(() => {
		if (selectedPackage) {
			details.current?.scrollIntoView?.({ block: 'start', inline: 'nearest' })
			details.current?.querySelector<HTMLButtonElement>('.pm-back')?.focus({ preventScroll: true })
		} else if (returnTo.current) {
			const { button, scroll, top } = returnTo.current
			returnTo.current = undefined
			if (scroll) scroll.scrollTop = top
			const focus = button.isConnected ? button : searchInput.current
			focus?.focus({ preventScroll: true })
		}
	}, [selectedPackage])

	return (
		<>
			<div className="pm-catalog" ref={catalog} hidden={Boolean(selectedPackage)}>
				<data.Facets filters={filters}>
					{(read) => (
						<CatalogFilters
							read={read}
							query={query}
							searchInput={searchInput}
							selection={selection}
							official={official}
							onQuery={applyQuery}
							onToggle={toggle}
							onOfficial={(value) => {
								setOfficial(value)
								restart()
							}}
							onClear={() => {
								setSelection(emptySelection)
								setOfficial(undefined)
								restart()
							}}
						/>
					)}
				</data.Facets>
				<data.Packages query={pageQuery}>
					{(read) => {
						const page = read.data?.ok ? read.data.value : undefined
						const next = page?.nextCursor
						return (
							<>
								<ReadStatus
									query={read}
									title="Market unavailable"
									loadingLabel="Loading packages"
									retryLabel="Retry market"
								/>
								{page?.packages.length === 0 ? (
									<div className="pm-empty">
										<h3>No matching packages</h3>
										<p>Try another search or remove a filter.</p>
									</div>
								) : null}
								{page?.packages.length ? (
									<div className="pm-results">
										<div className="pm-result-header" aria-hidden="true">
											<span>Package</span>
											<span>Author / organization</span>
											<span>Category</span>
											<span>Source</span>
											<span>Latest</span>
										</div>
										<ul aria-label="Plugin catalog">
											{page.packages.map((pkg) => (
												<PackageRow
													key={JSON.stringify([pkg.registry, pkg.name])}
													pkg={pkg}
													authorSelected={selection.authors.some(
														({ value }) => value === pkg.author?.id,
													)}
													authorLimit={selection.authors.length >= marketFilterLimit}
													onOpen={(button) => openPackage(pkg, button)}
													onAuthor={(author) =>
														toggle('authors', {
															value: author.id,
															label: author.name,
															avatarUrl: author.avatarUrl,
														})
													}
												/>
											))}
										</ul>
									</div>
								) : null}
								{cursors.length > 0 || next ? (
									<Pagination
										page={cursors.length + 1}
										busy={read.isFetching}
										previous={cursors.length > 0}
										next={Boolean(next)}
										onPrevious={() => {
											setCursors((current) => current.slice(0, -1))
											scrollToCatalog()
										}}
										onNext={() => {
											if (next) setCursors((current) => [...current, next])
											scrollToCatalog()
										}}
									/>
								) : null}
							</>
						)
					}}
				</data.Packages>
			</div>
			{selectedPackage ? (
				<div ref={details}>
					<PackageDetails
						key={JSON.stringify([selectedPackage.registry, selectedPackage.name])}
						data={data}
						pkg={selectedPackage}
						busy={busy}
						onPrepare={onPrepare}
						onClose={() => setSelectedPackage(undefined)}
					/>
				</div>
			) : null}
		</>
	)
}

function scrollContainer(element: HTMLElement): Element | null {
	const { ownerDocument } = element
	for (let parent = element.parentElement; parent; parent = parent.parentElement) {
		const overflow = ownerDocument.defaultView?.getComputedStyle(parent).overflowY
		if (overflow === 'auto' || overflow === 'scroll') return parent
	}
	return ownerDocument.scrollingElement
}

function PackageRow({
	pkg,
	authorSelected,
	authorLimit,
	onOpen,
	onAuthor,
}: Readonly<{
	pkg: MarketPackageSummary
	authorSelected: boolean
	authorLimit: boolean
	onOpen(button: HTMLButtonElement): void
	onAuthor(author: NonNullable<MarketPackageSummary['author']>): void
}>) {
	const { author } = pkg
	return (
		<li className="pm-result-row">
			<div className="pm-package">
				<div className="pm-package-heading">
					<button
						type="button"
						className="pm-text-action pm-package-name pm-truncate"
						title={pkg.name}
						aria-label={pkg.name + ' from ' + registryLabel(pkg.registry)}
						onClick={(event) => onOpen(event.currentTarget)}
					>
						{pkg.name}
					</button>
					{pkg.official ? <span className="pm-badge pm-official">Official</span> : null}
				</div>
				{pkg.description ? (
					<p className="pm-summary pm-truncate" title={pkg.description}>
						{pkg.description}
					</p>
				) : null}
			</div>
			<div className="pm-package-author">
				{author ? (
					<button
						type="button"
						className="pm-text-action pm-author"
						title={
							author.kind === 'github'
								? author.name + ' · Declared GitHub repository owner'
								: author.name
						}
						aria-label={'Filter by author ' + author.name}
						aria-pressed={authorSelected}
						disabled={!authorSelected && authorLimit}
						onClick={() => onAuthor(author)}
					>
						<AuthorAvatar url={author.avatarUrl} />
						<span className="pm-truncate">{author.name}</span>
					</button>
				) : (
					<span className="pm-unset" aria-label="Author unavailable">
						—
					</span>
				)}
			</div>
			<span
				className="pm-row-category pm-truncate"
				title={pkg.category ? categoryLabel(pkg.category) : undefined}
			>
				{pkg.category ? categoryLabel(pkg.category) : <span className="pm-unset">—</span>}
			</span>
			<span className="pm-row-source pm-truncate" title={pkg.registry}>
				{registryLabel(pkg.registry)}
			</span>
			<div className="pm-row-version">
				<span className="pm-sr-only">Registry latest</span>
				<code className="pm-truncate" title={pkg.latest ?? undefined}>
					{pkg.latest ?? '—'}
				</code>
				{pkg.indexedVersions === 0 ? (
					<span className="pm-no-release" title="No installable releases">
						Metadata only
					</span>
				) : null}
			</div>
		</li>
	)
}

function PackageDetails(
	props: BrowseProps & Readonly<{ pkg: MarketPackageSummary; onClose(): void }>,
) {
	return (
		<props.data.Package identity={{ registry: props.pkg.registry, name: props.pkg.name }}>
			{(query) => <PackageOverview {...props} query={query} />}
		</props.data.Package>
	)
}

function PackageOverview({
	data,
	pkg,
	busy,
	onPrepare,
	onClose,
	query,
}: BrowseProps &
	Readonly<{
		pkg: MarketPackageSummary
		onClose(): void
		query: MarketplaceRead<MarketPackageDetail>
	}>) {
	const detail = query.data?.ok ? query.data.value : undefined
	const author = (detail ?? pkg).author
	const [tab, setTab] = useState('overview')
	const identity = { registry: pkg.registry, name: pkg.name }
	return (
		<div className="pm-stack" aria-label="Package details">
			<div>
				<button type="button" className="pm-button pm-quiet pm-back" onClick={onClose}>
					<svg
						width="16"
						height="16"
						viewBox="0 0 20 20"
						fill="none"
						stroke="currentColor"
						aria-hidden="true"
					>
						<path d="m9 4-6 6 6 6M3 10h14" />
					</svg>
					Back to packages
				</button>
			</div>
			<header className="pm-detail-header">
				<div className="pm-inline">
					<h2>{pkg.name}</h2>
					{(detail ?? pkg).official ? <span className="pm-badge pm-official">Official</span> : null}
				</div>
				{(detail ?? pkg).description ? (
					<p className="pm-detail-description">{(detail ?? pkg).description}</p>
				) : null}
				<div className="pm-detail-facts">
					{author ? <AuthorFact author={author} /> : null}
					<p className="pm-source">
						<span>Registry</span>
						<span>{pkg.registry}</span>
					</p>
					<RepositoryLink pkg={detail ?? pkg} />
				</div>
				<div className="pm-tags">
					{(detail ?? pkg).category ? (
						<span className="pm-chip pm-category">{(detail ?? pkg).category}</span>
					) : null}
					{(detail ?? pkg).tags.map((tag) => (
						<span key={tag} className="pm-chip">
							#{tag}
						</span>
					))}
				</div>
			</header>
			<TabBar
				value={tab}
				onChange={setTab}
				label="Package information"
				tabs={['Overview', 'Versions']}
			/>
			{tab === 'overview' ? (
				<div className="pm-stack">
					<ReadStatus
						query={query}
						title="Package details unavailable"
						loadingLabel="Loading package details"
						retryLabel="Retry package"
					/>
					{detail ? (
						<>
							<div className="pm-overview-facts">
								{detail.metadataVersion ? (
									<Fact label="Metadata version">{detail.metadataVersion}</Fact>
								) : null}
								{detail.license ? <Fact label="License">{detail.license}</Fact> : null}
								<NpmxLink
									registry={detail.registry}
									name={detail.name}
									version={detail.metadataVersion}
								/>
							</div>
							{detail.indexedVersions === 0 ? (
								<p className="pm-note">No releases are available to install from this market.</p>
							) : null}
							<section className="pm-document">
								<h3>Registry README</h3>
								<Readme value={detail.readme} />
							</section>
						</>
					) : null}
				</div>
			) : (
				<ReleaseVersions
					data={data}
					identity={identity}
					latest={detail ? detail.latest : pkg.latest}
					busy={busy}
					onPrepare={onPrepare}
				/>
			)}
		</div>
	)
}

function AuthorFact({ author }: Readonly<{ author: NonNullable<MarketPackageSummary['author']> }>) {
	return (
		<Fact
			label={
				author.kind === 'github' ? 'Declared GitHub repository owner' : 'Author / organization'
			}
		>
			<span className="pm-author">
				<AuthorAvatar url={author.avatarUrl} />
				{author.name}
			</span>
		</Fact>
	)
}

function ReleaseVersions({
	data,
	identity,
	latest,
	busy,
	onPrepare,
}: BrowseProps & Readonly<{ identity: MarketPackageIdentity; latest: string | null }>) {
	const [cursors, setCursors] = useState<string[]>([])
	const [version, setVersion] = useState('')
	const cursor = cursors.at(-1)
	const id = useId()

	const renderVersions = (query: MarketplaceRead<MarketReleasePage>) => {
		const page = query.data?.ok ? query.data.value : undefined
		return (
			<div className="pm-stack" aria-label="Available package versions">
				<p className="pm-muted">
					Only releases checked by this market are listed.{' '}
					{latest ? 'Registry latest: ' + latest + '.' : 'The registry has no latest release.'}
				</p>
				<ReadStatus
					query={query}
					title="Versions unavailable"
					loadingLabel="Loading package versions"
					retryLabel="Retry versions"
				/>
				{page?.releases.length === 0 ? (
					<p className="pm-note">
						{cursors.length === 0
							? 'No releases are available to install from this market.'
							: 'No indexed versions on this page.'}
					</p>
				) : null}
				{page?.releases.length ? (
					<div className="pm-field pm-version-field">
						<label htmlFor={id}>Package version</label>
						<select
							id={id}
							value={version}
							disabled={query.isFetching || Boolean(errorOf(query))}
							onChange={(event) => setVersion(event.currentTarget.value)}
						>
							<option value="">Select a version</option>
							{page.releases.map((release) => (
								<option key={release.version} value={release.version}>
									{release.version === latest ? release.version + ' (latest)' : release.version}
								</option>
							))}
						</select>
					</div>
				) : null}
				{page && (cursors.length > 0 || page.nextCursor) ? (
					<Pagination
						page={cursors.length + 1}
						busy={query.isFetching}
						previous={cursors.length > 0}
						next={Boolean(page.nextCursor)}
						suffix=" versions"
						onPrevious={() => {
							setCursors((current) => current.slice(0, -1))
							setVersion('')
						}}
						onNext={() => {
							if (page.nextCursor) setCursors((current) => [...current, page.nextCursor!])
							setVersion('')
						}}
					/>
				) : null}
				{version ? (
					<ReleaseDetails
						key={version}
						data={data}
						selection={{ ...identity, version }}
						busy={busy}
						onPrepare={onPrepare}
						onClose={() => setVersion('')}
					/>
				) : null}
			</div>
		)
	}
	return (
		<data.Releases
			identity={identity}
			query={{ registry: identity.registry, limit: 20, ...(cursor ? { cursor } : {}) }}
		>
			{renderVersions}
		</data.Releases>
	)
}

function ReleaseDetails(
	props: BrowseProps & Readonly<{ selection: MarketReleaseIdentity; onClose(): void }>,
) {
	return (
		<props.data.Release identity={props.selection}>
			{(query) => <ReleaseOverview {...props} query={query} />}
		</props.data.Release>
	)
}

function ReleaseOverview({
	selection,
	busy,
	onPrepare,
	onClose,
	query,
}: BrowseProps &
	Readonly<{
		selection: MarketReleaseIdentity
		onClose(): void
		query: MarketplaceRead<MarketRelease>
	}>) {
	const release = query.data?.ok ? query.data.value : undefined
	const [tab, setTab] = useState('readme')
	return (
		<section className="pm-release pm-stack" aria-label="Release details">
			<div className="pm-between">
				<h3>
					{selection.name}@{selection.version}
				</h3>
				<button type="button" className="pm-button pm-quiet" onClick={onClose}>
					Close details
				</button>
			</div>
			<ReadStatus
				query={query}
				title="Release unavailable"
				loadingLabel="Loading release details"
				retryLabel="Retry release"
			/>
			{release ? (
				<>
					<div className="pm-overview-facts">
						<Fact label="Registry">{release.registry}</Fact>
						{release.license ? <Fact label="License">{release.license}</Fact> : null}
						<NpmxLink registry={release.registry} name={release.name} version={release.version} />
					</div>
					{release.provenance.status === 'verified' ? (
						<div className="pm-provenance">
							<div className="pm-inline">
								<span className="pm-badge pm-verified">Source verified</span>
								<a href={release.provenance.repository} target="_blank" rel="noopener noreferrer">
									Source repository
								</a>
								{release.provenance.buildUrl ? (
									<a href={release.provenance.buildUrl} target="_blank" rel="noopener noreferrer">
										Build
									</a>
								) : null}
							</div>
							<p className="pm-small pm-muted">
								Commit: <code>{release.provenance.commit}</code>
							</p>
						</div>
					) : (
						<p className="pm-small pm-muted">No verified build provenance.</p>
					)}
					<TabBar
						value={tab}
						onChange={setTab}
						label="Release information"
						tabs={['README', 'Dependencies', 'Integrity']}
					/>
					{tab === 'readme' ? (
						<section className="pm-document">
							<p className="pm-small pm-muted">README from the checked package archive.</p>
							<Readme value={release.readme} />
						</section>
					) : tab === 'dependencies' ? (
						<Dependencies release={release} />
					) : (
						<div className="pm-document">
							<p className="pm-integrity">
								<code>{release.integrity}</code>
							</p>
							<p className="pm-small pm-muted">
								Checked {new Date(release.checkedAt).toLocaleString()}
							</p>
						</div>
					)}
					{onPrepare ? (
						<div className="pm-install">
							<p className="pm-small pm-muted">
								Review this exact release before installing it in your application.
							</p>
							<button
								type="button"
								className="pm-button pm-primary"
								disabled={busy || Boolean(errorOf(query))}
								onClick={() => onPrepare(selection)}
							>
								Review installation
							</button>
						</div>
					) : null}
				</>
			) : null}
		</section>
	)
}

function RepositoryLink({
	pkg,
}: Readonly<{
	pkg: Pick<MarketPackageSummary, 'repository' | 'repositoryStars' | 'repositoryObservedAt'>
}>) {
	if (!pkg.repository) return null
	return (
		<div className="pm-repository">
			<a href={pkg.repository} target="_blank" rel="noopener noreferrer">
				Repository
			</a>
			{pkg.repositoryStars !== null && pkg.repositoryObservedAt !== null ? (
				<span
					className="pm-stars"
					aria-label={pkg.repositoryStars + ' repository stars'}
					title={'Observed ' + new Date(pkg.repositoryObservedAt).toLocaleString()}
				>
					<Star />
					{new Intl.NumberFormat().format(pkg.repositoryStars)}
				</span>
			) : null}
		</div>
	)
}

function NpmxLink({
	registry,
	name,
	version,
}: Readonly<{ registry: string; name: string; version: string | null }>) {
	if (registry !== 'https://registry.npmjs.org' || !version) return null
	return (
		<a
			className="pm-external"
			href={'https://npmx.dev/package/' + name + '/v/' + encodeURIComponent(version)}
			target="_blank"
			rel="noopener noreferrer"
		>
			View on npmx<span aria-hidden="true">↗</span>
		</a>
	)
}

function Dependencies({ release }: Readonly<{ release: MarketRelease }>) {
	const names = [
		...new Set([...Object.keys(release.peerDependencies), ...Object.keys(release.pluginPackages)]),
	].sort()
	if (names.length === 0)
		return <p className="pm-muted">No peer or plugin dependencies are declared.</p>
	return (
		<dl className="pm-dependencies">
			{names.map((name) => (
				<div key={name}>
					<dt>
						<code>{name}</code>
					</dt>
					<dd>
						<span className="pm-muted">{release.peerDependencies[name]}</span>
						<span className="pm-badge">
							{release.pluginPackages[name] ? release.pluginPackages[name] + ' plugin' : 'Peer'}
						</span>
					</dd>
				</div>
			))}
		</dl>
	)
}

function Fact({ label, children }: Readonly<{ label: string; children: ReactNode }>) {
	return (
		<div className="pm-fact">
			<span className="pm-small pm-muted">{label}</span>
			<span>{children}</span>
		</div>
	)
}

function TabBar({
	value,
	tabs,
	onChange,
	label,
}: Readonly<{
	value: string
	tabs: readonly string[]
	onChange(value: string): void
	label: string
}>) {
	return (
		<nav className="pm-tabs" aria-label={label}>
			{tabs.map((tab) => (
				<button
					key={tab}
					type="button"
					aria-pressed={value === tab.toLowerCase()}
					onClick={() => onChange(tab.toLowerCase())}
				>
					{tab}
				</button>
			))}
		</nav>
	)
}

function Pagination({
	page,
	previous,
	next,
	busy,
	suffix = '',
	onPrevious,
	onNext,
}: Readonly<{
	page: number
	previous: boolean
	next: boolean
	busy: boolean
	suffix?: string
	onPrevious(): void
	onNext(): void
}>) {
	return (
		<div className="pm-pagination">
			<button
				type="button"
				className="pm-button pm-quiet"
				disabled={!previous || busy}
				onClick={onPrevious}
			>
				{'Previous' + suffix}
			</button>
			<span className="pm-muted pm-small">Page {page}</span>
			<button
				type="button"
				className="pm-button pm-quiet"
				disabled={!next || busy}
				onClick={onNext}
			>
				{'Next' + suffix}
			</button>
		</div>
	)
}

function errorOf<T>(query: MarketplaceRead<T>): string | undefined {
	if (query.error !== undefined && query.error !== null)
		return query.error instanceof Error ? query.error.message : String(query.error)
	return query.data && query.data.ok === false ? query.data.error.message : undefined
}

function ReadStatus<T>({
	query,
	title,
	loadingLabel,
	retryLabel,
}: Readonly<{
	query: MarketplaceRead<T>
	title: string
	loadingLabel: string
	retryLabel: string
}>) {
	const error = errorOf(query)
	return (
		<>
			{error ? (
				<div className="pm-error" role="alert">
					<div>
						<strong>{title}</strong>
						<p>{error}</p>
					</div>
					<button
						type="button"
						className="pm-button"
						disabled={query.isFetching}
						onClick={() => void query.refetch().catch((): void => {})}
					>
						{retryLabel}
					</button>
				</div>
			) : null}
			{query.isFetching ? (
				<p className="pm-loading" role="status" aria-label={loadingLabel}>
					<span aria-hidden="true" />
					{loadingLabel}…
				</p>
			) : null}
		</>
	)
}

function Star() {
	return (
		<svg
			width="18"
			height="18"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.6"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path d="m12 3 2.8 5.7 6.3.9-4.55 4.43L17.6 20.3 12 17.35 6.4 20.3l1.05-6.27L2.9 9.6l6.3-.9Z" />
		</svg>
	)
}
