import { useId, useState, type ReactNode, type ComponentType } from 'react'
import type {
	MarketPackageIdentity,
	MarketPackageQuery,
	MarketPackageSummary,
	MarketPackageDetail,
	MarketPackagePage,
	MarketReleaseIdentity,
	MarketReleaseQuery,
	MarketRelease,
	MarketReleasePage,
	MarketReadResult,
} from '../market-contracts.ts'
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
const emptyFilters = { query: '', registry: '', official: '', category: '', tag: '' }

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
	const [draft, setDraft] = useState(emptyFilters)
	const [filters, setFilters] = useState<MarketPackageQuery>({})
	const [cursors, setCursors] = useState<string[]>([])
	const [selection, setSelection] = useState<MarketPackageSummary>()
	const [filtersExpanded, setFiltersExpanded] = useState(false)
	const id = useId()
	const filterCount = [filters.registry, filters.official, filters.category, filters.tag].filter(
		(value) => value !== undefined,
	).length
	const cursor = cursors.at(-1)
	const applyFilters = (next: typeof emptyFilters) => {
		setDraft(next)
		setFilters({
			...(next.query.trim() ? { query: next.query.trim() } : {}),
			...(next.registry.trim() ? { registry: next.registry.trim() } : {}),
			...(next.official ? { official: next.official === 'true' } : {}),
			...(next.category.trim() ? { category: next.category.trim() } : {}),
			...(next.tag.trim() ? { tag: next.tag.trim() } : {}),
		})
		setCursors([])
		setSelection(undefined)
	}
	const renderPackages = (query: MarketplaceRead<MarketPackagePage>) => {
		const page = query.data?.ok ? query.data.value : undefined
		if (selection)
			return (
				<PackageDetails
					key={JSON.stringify([selection.registry, selection.name])}
					data={data}
					pkg={selection}
					busy={busy}
					onPrepare={onPrepare}
					onClose={() => setSelection(undefined)}
				/>
			)
		return (
			<div className="pm-stack">
				<form
					className="pm-search"
					onSubmit={(event) => {
						event.preventDefault()
						applyFilters(draft)
					}}
				>
					<div className="pm-search-row">
						<div className="pm-search-field">
							<label htmlFor={id + '-search'}>Search packages</label>
							<div className="pm-search-input">
								<Icon name="search" />
								<input
									id={id + '-search'}
									type="search"
									placeholder="Name, description or tags"
									maxLength={100}
									value={draft.query}
									onChange={(event) => setDraft({ ...draft, query: event.currentTarget.value })}
								/>
							</div>
						</div>
						<button type="submit" className="pm-button pm-primary">
							Search
						</button>
					</div>
					<div className="pm-toolbar">
						<button
							type="button"
							className="pm-button pm-quiet"
							aria-expanded={filtersExpanded}
							aria-controls={id + '-filters'}
							onClick={() => setFiltersExpanded((current) => !current)}
						>
							<Icon name="filter" />
							Filters{filterCount ? ' (' + filterCount + ')' : ''}
						</button>
						<div className="pm-inline">
							<span className="pm-muted pm-small" aria-live="polite">
								{page ? page.packages.length + ' packages' : 'Plugin catalog'}
							</span>
							<button
								type="button"
								className="pm-button pm-quiet"
								onClick={() => applyFilters(emptyFilters)}
							>
								Reset filters
							</button>
						</div>
					</div>
					<fieldset id={id + '-filters'} className="pm-filters" hidden={!filtersExpanded}>
						<legend className="pm-sr-only">Filter plugins</legend>
						<div className="pm-field">
							<label htmlFor={id + '-registry'}>Registry</label>
							<input
								id={id + '-registry'}
								type="url"
								placeholder="All registries"
								value={draft.registry}
								onChange={(event) => setDraft({ ...draft, registry: event.currentTarget.value })}
							/>
						</div>
						<div className="pm-field">
							<label htmlFor={id + '-publisher'}>Publisher</label>
							<select
								id={id + '-publisher'}
								value={draft.official}
								onChange={(event) => setDraft({ ...draft, official: event.currentTarget.value })}
							>
								<option value="">All plugins</option>
								<option value="true">Official only</option>
								<option value="false">Community only</option>
							</select>
						</div>
						<div className="pm-field">
							<label htmlFor={id + '-category'}>Category</label>
							<input
								id={id + '-category'}
								placeholder="All categories"
								maxLength={32}
								value={draft.category}
								onChange={(event) => setDraft({ ...draft, category: event.currentTarget.value })}
							/>
						</div>
						<div className="pm-field">
							<label htmlFor={id + '-tag'}>Tag</label>
							<input
								id={id + '-tag'}
								placeholder="Any tag"
								maxLength={32}
								value={draft.tag}
								onChange={(event) => setDraft({ ...draft, tag: event.currentTarget.value })}
							/>
						</div>
					</fieldset>
					{filterCount > 0 ? (
						<p className="pm-applied pm-muted pm-small">
							{[
								filters.registry,
								filters.official === undefined ? null : filters.official ? 'Official' : 'Community',
								filters.category,
								filters.tag ? '#' + filters.tag : null,
							]
								.filter(Boolean)
								.join(' · ')}
						</p>
					) : null}
				</form>
				<ReadStatus
					query={query}
					title="Market unavailable"
					loadingLabel="Loading market packages"
					retryLabel="Retry market"
				/>
				{page?.packages.length === 0 ? (
					<div className="pm-empty">
						<Icon name="package" />
						<h3>No matching packages</h3>
						<p>Try another name or adjust the filters.</p>
					</div>
				) : null}
				{page ? (
					<div className="pm-grid" aria-label="Plugin catalog">
						{page.packages.map((pkg) => (
							<PackageCard
								key={JSON.stringify([pkg.registry, pkg.name])}
								pkg={pkg}
								onSelect={() => setSelection(pkg)}
								onCategory={(category) => applyFilters({ ...draft, category })}
								onTag={(tag) => applyFilters({ ...draft, tag })}
							/>
						))}
					</div>
				) : null}
				{page ? (
					<Pagination
						page={cursors.length + 1}
						busy={query.isFetching}
						previous={cursors.length > 0}
						next={Boolean(page.nextCursor)}
						onPrevious={() => setCursors((current) => current.slice(0, -1))}
						onNext={() => {
							if (page.nextCursor) setCursors((current) => [...current, page.nextCursor!])
						}}
					/>
				) : null}
			</div>
		)
	}
	return (
		<data.Packages query={{ ...filters, limit: 20, ...(cursor ? { cursor } : {}) }}>
			{renderPackages}
		</data.Packages>
	)
}

function PackageCard({
	pkg,
	onSelect,
	onCategory,
	onTag,
}: Readonly<{
	pkg: MarketPackageSummary
	onSelect(): void
	onCategory(value: string): void
	onTag(value: string): void
}>) {
	return (
		<article className="pm-card" aria-label={pkg.name + ' from ' + pkg.registry}>
			<div className="pm-card-heading">
				<span className="pm-package-icon">
					<Icon name="package" />
				</span>
				{pkg.official ? <span className="pm-badge pm-official">Official</span> : null}
			</div>
			<h3>{pkg.name}</h3>
			<p className="pm-description">{pkg.description || 'No description provided.'}</p>
			<div className="pm-tags">
				{pkg.category ? (
					<button
						type="button"
						className="pm-chip pm-category"
						aria-label={'Filter category ' + pkg.category}
						onClick={() => onCategory(pkg.category!)}
					>
						{pkg.category}
					</button>
				) : null}
				{pkg.tags.map((tag) => (
					<button
						type="button"
						key={tag}
						className="pm-chip"
						aria-label={'Filter tag ' + tag}
						onClick={() => onTag(tag)}
					>
						#{tag}
					</button>
				))}
			</div>
			<p className="pm-source">
				<span>Registry</span>
				<span>{pkg.registry}</span>
			</p>
			<div className="pm-card-facts">
				<span>{pkg.latest ? 'Latest: ' + pkg.latest : 'No latest tag'}</span>
				<span>{pkg.indexedVersions} checked releases</span>
			</div>
			<footer className="pm-card-footer">
				<RepositoryLink pkg={pkg} />
				<button type="button" className="pm-button pm-link" onClick={onSelect}>
					View details
					<svg
						width="14"
						height="14"
						viewBox="0 0 20 20"
						fill="none"
						stroke="currentColor"
						aria-hidden="true"
					>
						<path d="M5 15 15 5M5 5h10v10" />
					</svg>
				</button>
			</footer>
		</article>
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
					<span className="pm-package-icon">
						<Icon name="package" />
					</span>
					{(detail ?? pkg).official ? <span className="pm-badge pm-official">Official</span> : null}
				</div>
				<h2>{pkg.name}</h2>
				{(detail ?? pkg).description ? (
					<p className="pm-detail-description">{(detail ?? pkg).description}</p>
				) : null}
				<div className="pm-detail-facts">
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
					<Icon name="star" />
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

function Icon({ name }: Readonly<{ name: 'search' | 'filter' | 'star' | 'package' }>) {
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
			{name === 'search' ? (
				<>
					<circle cx="10.5" cy="10.5" r="6.5" />
					<path d="m16 16 4.5 4.5" />
				</>
			) : name === 'filter' ? (
				<>
					<path d="M4 7h16M4 17h16" />
					<circle cx="9" cy="7" r="2" fill="var(--pm-surface)" />
					<circle cx="15" cy="17" r="2" fill="var(--pm-surface)" />
				</>
			) : name === 'star' ? (
				<path d="m12 3 2.8 5.7 6.3.9-4.55 4.43L17.6 20.3 12 17.35 6.4 20.3l1.05-6.27L2.9 9.6l6.3-.9Z" />
			) : (
				<>
					<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9Z" />
					<path d="m4 7.5 8 4.5 8-4.5M12 12v9M8 5.25l8 4.5" />
				</>
			)}
		</svg>
	)
}
