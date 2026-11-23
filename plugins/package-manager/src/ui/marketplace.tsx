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
	/** Optional host-owned status shown with the package summary and in its detail. */
	packageStatus?(pkg: MarketPackageSummary): ReactNode
	/** An independent action beside the package title on cards and in details. */
	packageAction?(pkg: MarketPackageSummary): ReactNode
	/** Actions for the exact release currently displayed after a successful read. */
	releaseAction?(release: MarketRelease): ReactNode
	/** Optional host-specific annotation beside an exact version. */
	versionNote?(selection: MarketReleaseIdentity): string | undefined
	/** Reports opening a package or returning to the catalog within this instance. */
	onPackageChange?(selection: MarketPackageIdentity | null): void
	/** Fixed appearance for this surface. @defaultValue 'light' */
	colorScheme?: 'light' | 'dark'
}>

type BrowseProps = Pick<MarketplaceProps, 'data' | 'releaseAction' | 'versionNote'>

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

function MarketPackages({
	data,
	packageAction,
	releaseAction,
	packageStatus,
	versionNote,
	onPackageChange,
}: Omit<MarketplaceProps, 'colorScheme'>) {
	const [query, setQuery] = useState('')
	const [selection, setSelection] = useState(emptySelection)
	const [official, setOfficial] = useState<boolean>()
	const [cursors, setCursors] = useState<string[]>([])
	const [selectedPackage, setSelectedPackage] = useState<MarketPackageSummary>()
	const catalog = useRef<HTMLDivElement>(null)
	const details = useRef<HTMLDivElement>(null)
	const searchInput = useRef<HTMLInputElement>(null)
	const returnTo = useRef<
		{ button: HTMLButtonElement; scroll: Element | null; top: number } | 'results'
	>(undefined)
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
		onPackageChange?.({ name: pkg.name, registry: pkg.registry })
	}
	const closePackage = () => {
		setSelectedPackage(undefined)
		onPackageChange?.(null)
	}
	const authorSelected = (author: MarketPackageSummary['author']) =>
		selection.authors.some(({ value }) => value === author?.id)
	const toggleOwner = (author: NonNullable<MarketPackageSummary['author']>) =>
		toggle('authors', { value: author.id, label: author.name, avatarUrl: author.avatarUrl })
	const ownerLimit = selection.authors.length >= marketFilterLimit

	useLayoutEffect(() => {
		if (selectedPackage) {
			details.current?.scrollIntoView?.({ block: 'start', inline: 'nearest' })
			details.current?.querySelector<HTMLButtonElement>('.pm-back')?.focus({ preventScroll: true })
		} else if (returnTo.current === 'results') {
			returnTo.current = undefined
			scrollToCatalog()
			searchInput.current?.focus({ preventScroll: true })
		} else if (returnTo.current) {
			const { button, scroll, top } = returnTo.current
			returnTo.current = undefined
			if (scroll) scroll.scrollTop = top
			const focus = button.isConnected ? button : searchInput.current
			focus?.focus({ preventScroll: true })
		}
	}, [selectedPackage, scrollToCatalog])

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
				<div className="pm-catalog-results">
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
										<ul className="pm-results" aria-label="Plugin catalog">
											{page.packages.map((pkg) => (
												<PackageCard
													key={JSON.stringify([pkg.registry, pkg.name])}
													pkg={pkg}
													action={packageAction?.(pkg)}
													status={packageStatus?.(pkg)}
													authorSelected={authorSelected(pkg.author)}
													authorLimit={ownerLimit}
													onOpen={(button) => openPackage(pkg, button)}
													onAuthor={toggleOwner}
												/>
											))}
										</ul>
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
			</div>
			{selectedPackage ? (
				<div className="pm-detail-anchor" ref={details}>
					<PackageDetails
						key={JSON.stringify([selectedPackage.registry, selectedPackage.name])}
						data={data}
						pkg={selectedPackage}
						packageAction={packageAction}
						releaseAction={releaseAction}
						packageStatus={packageStatus}
						versionNote={versionNote}
						onClose={closePackage}
						canFilterOwner={(author) => authorSelected(author) || !ownerLimit}
						onFilterOwner={(author) => {
							if (!authorSelected(author)) toggleOwner(author)
							returnTo.current = 'results'
							closePackage()
						}}
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

function PackageCard({
	pkg,
	action,
	status,
	authorSelected,
	authorLimit,
	onOpen,
	onAuthor,
}: Readonly<{
	pkg: MarketPackageSummary
	action: ReactNode
	status: ReactNode
	authorSelected: boolean
	authorLimit: boolean
	onOpen(button: HTMLButtonElement): void
	onAuthor(author: NonNullable<MarketPackageSummary['author']>): void
}>) {
	const { author } = pkg
	const category = pkg.category ? categoryLabel(pkg.category) : null
	const tags = pkg.tags.slice(0, 2)
	const remainingTags = pkg.tags.length - tags.length
	return (
		<li className="pm-package-card">
			<div className="pm-package-heading">
				{action}
				<button
					type="button"
					className="pm-text-action pm-package-name"
					title={pkg.name}
					aria-label={pkg.name + ' from ' + registryLabel(pkg.registry)}
					onClick={(event) => onOpen(event.currentTarget)}
				>
					<span className="pm-truncate">
						<PackageName name={pkg.name} />
					</span>
				</button>
				{pkg.official ? <span className="pm-badge pm-official">Official</span> : null}
			</div>
			{pkg.description ? (
				<p className="pm-summary" title={pkg.description}>
					{pkg.description}
				</p>
			) : null}
			<div className="pm-card-byline">
				{author ? (
					<button
						type="button"
						className="pm-text-action pm-author pm-card-author"
						title={'Filter by repository owner ' + author.name}
						aria-label={'Filter by repository owner ' + author.name}
						aria-pressed={authorSelected}
						disabled={!authorSelected && authorLimit}
						onClick={() => onAuthor(author)}
					>
						<AuthorAvatar url={author.avatarUrl} />
						<span className="pm-truncate">{author.name}</span>
					</button>
				) : (
					<span className="pm-owner-unknown">Repository owner unavailable</span>
				)}
				<RepositoryLink pkg={pkg} />
			</div>
			{tags.length > 0 || status ? (
				<div className="pm-card-metadata">
					{tags.length > 0 ? (
						<div className="pm-card-tags">
							{tags.map((tag) => (
								<span key={tag} className="pm-chip pm-truncate" title={tag}>
									#{tag}
								</span>
							))}
							{remainingTags > 0 ? (
								<span
									className="pm-chip pm-card-more-tags"
									title={pkg.tags.slice(tags.length).join(', ')}
								>
									+{remainingTags}
									<span className="pm-sr-only"> more tags</span>
								</span>
							) : null}
						</div>
					) : null}
					{status}
				</div>
			) : null}
			<div className="pm-card-footer">
				<div className="pm-card-origin">
					{category ? (
						<span className="pm-truncate" title={category}>
							{category}
						</span>
					) : null}
					<span className="pm-truncate" title={pkg.registry}>
						{registryLabel(pkg.registry)}
					</span>
				</div>
				{pkg.latest || pkg.indexedVersions === 0 ? (
					<div className="pm-card-version">
						{pkg.latest ? (
							<>
								<span className="pm-sr-only">Registry latest</span>
								<code className="pm-truncate" title={pkg.latest}>
									{pkg.latest}
								</code>
							</>
						) : null}
						{pkg.indexedVersions === 0 ? (
							<span className="pm-no-release" title="No installable releases">
								Metadata only
							</span>
						) : null}
					</div>
				) : null}
			</div>
		</li>
	)
}

function PackageName({ name }: Readonly<{ name: string }>) {
	const slash = name.indexOf('/')
	if (slash < 0) return name
	return (
		<>
			<span className="pm-scope">{name.slice(0, slash + 1)}</span>
			{name.slice(slash + 1)}
		</>
	)
}

type PackageDetailsProps = BrowseProps &
	Pick<MarketplaceProps, 'packageStatus' | 'packageAction'> &
	Readonly<{
		pkg: MarketPackageSummary
		onClose(): void
		canFilterOwner(author: NonNullable<MarketPackageSummary['author']>): boolean
		onFilterOwner(author: NonNullable<MarketPackageSummary['author']>): void
	}>

function PackageDetails(props: PackageDetailsProps) {
	return (
		<props.data.Package identity={{ registry: props.pkg.registry, name: props.pkg.name }}>
			{(query) => <PackageOverview {...props} query={query} />}
		</props.data.Package>
	)
}

function PackageOverview({
	data,
	pkg,
	packageAction,
	releaseAction,
	packageStatus,
	versionNote,
	onClose,
	canFilterOwner,
	onFilterOwner,
	query,
}: PackageDetailsProps & Readonly<{ query: MarketplaceRead<MarketPackageDetail> }>) {
	const detail = query.data?.ok ? query.data.value : undefined
	const summary = detail ?? pkg
	const { author } = summary
	const [tab, setTab] = useState('overview')
	const identity = { registry: pkg.registry, name: pkg.name }
	const region = useRef<HTMLElement>(null)
	useLayoutEffect(() => {
		const element = region.current
		if (!element) return undefined
		function returnOnEscape(event: KeyboardEvent) {
			if (
				event.key !== 'Escape' ||
				event.defaultPrevented ||
				event.isComposing ||
				(event.target instanceof Element &&
					event.target.closest(
						'input, select, textarea, [contenteditable="true"], [role="combobox"]',
					))
			)
				return
			event.preventDefault()
			event.stopPropagation()
			onClose()
		}
		element.addEventListener('keydown', returnOnEscape)
		return () => element.removeEventListener('keydown', returnOnEscape)
	}, [onClose])
	return (
		<section ref={region} className="pm-details" aria-label="Package details">
			<div className="pm-detail-navigation">
				<nav className="pm-return" aria-label="Package navigation">
					<button
						type="button"
						className="pm-button pm-quiet pm-back"
						aria-keyshortcuts="Escape"
						onClick={onClose}
					>
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
					<kbd aria-hidden="true">Esc</kbd>
				</nav>
				<TabBar
					value={tab}
					onChange={setTab}
					label="Package information"
					tabs={['Overview', 'Versions']}
				/>
			</div>
			<header className="pm-detail-header">
				<div className="pm-detail-title">
					<h2>
						<PackageName name={pkg.name} />
					</h2>
					{summary.latest ? (
						<span className="pm-latest" title={'Registry latest: ' + summary.latest}>
							<span>latest</span> <code>{summary.latest}</code>
						</span>
					) : null}
					{summary.official ? <span className="pm-badge pm-official">Official</span> : null}
					{packageStatus?.(summary)}
					{packageAction?.(summary)}
				</div>
				{summary.description ? (
					<p className="pm-detail-description">{summary.description}</p>
				) : null}
				<div className="pm-detail-byline">
					<div className="pm-attribution">
						<span className="pm-registry" title={pkg.registry}>
							<span className="pm-sr-only">Registry </span>
							{registryLabel(pkg.registry)}
						</span>
						{author ? (
							<button
								type="button"
								className="pm-text-action pm-author pm-owner-link"
								aria-label={'Show packages from repository owner ' + author.name}
								title={'Show packages from repository owner ' + author.name}
								disabled={!canFilterOwner(author)}
								onClick={() => onFilterOwner(author)}
							>
								<AuthorAvatar url={author.avatarUrl} />
								{author.name}
							</button>
						) : (
							<span className="pm-owner-unknown">Repository owner unavailable</span>
						)}
						<RepositoryLink pkg={summary} />
					</div>
					<div className="pm-tags">
						{summary.category ? (
							<span className="pm-chip pm-category">{categoryLabel(summary.category)}</span>
						) : null}
						{summary.tags.map((tag) => (
							<span key={tag} className="pm-chip">
								#{tag}
							</span>
						))}
					</div>
				</div>
			</header>
			{tab === 'overview' ? (
				<>
					<ReadStatus
						query={query}
						title="Package details unavailable"
						loadingLabel="Loading package details"
						retryLabel="Retry package"
					/>
					{detail ? (
						<div className="pm-overview">
							<aside className="pm-package-meta" aria-label="Package metadata">
								<h3>Package metadata</h3>
								<dl className="pm-facts">
									{detail.metadataVersion ? (
										<Fact label="Metadata version">
											<code>{detail.metadataVersion}</code>
										</Fact>
									) : null}
									{detail.license ? <Fact label="License">{detail.license}</Fact> : null}
									<Fact label="Checked releases">{detail.indexedVersions}</Fact>
								</dl>
								{detail.indexedVersions === 0 ? (
									<p className="pm-coverage">No checked releases are available from this market.</p>
								) : null}
								<NpmxLink
									registry={detail.registry}
									name={detail.name}
									version={detail.metadataVersion}
								/>
							</aside>
							<section className="pm-document">
								<h3>Registry README</h3>
								<Readme value={detail.readme} />
							</section>
						</div>
					) : null}
				</>
			) : (
				<ReleaseVersions
					data={data}
					identity={identity}
					latest={detail ? detail.latest : pkg.latest}
					releaseAction={releaseAction}
					versionNote={versionNote}
				/>
			)}
		</section>
	)
}

function ReleaseVersions({
	data,
	identity,
	latest,
	releaseAction,
	versionNote,
}: BrowseProps & Readonly<{ identity: MarketPackageIdentity; latest: string | null }>) {
	const [version, setVersion] = useState('')
	return (
		<div className="pm-versions" aria-label="Available package versions">
			<p className="pm-small pm-muted">
				Only releases checked by this market are listed.{' '}
				{latest ? 'Registry latest: ' + latest + '.' : 'The registry has no latest release.'}
			</p>
			<MarketVersionPicker
				data={data}
				identity={identity}
				latest={latest}
				versionNote={versionNote}
				label="Package version"
				value={version}
				onChange={setVersion}
				onPageChange={() => setVersion('')}
			/>
			{version ? (
				<ReleaseDetails
					key={version}
					data={data}
					selection={{ ...identity, version }}
					releaseAction={releaseAction}
					onClose={() => setVersion('')}
				/>
			) : null}
		</div>
	)
}

/** Both the browsing detail and the host's selection form read the same indexed version pages. */
export function MarketVersionPicker({
	data,
	identity,
	latest,
	versionNote,
	label,
	name,
	value,
	onChange,
	onPageChange,
	disabled,
}: Pick<MarketplaceProps, 'data' | 'versionNote'> &
	Readonly<{
		identity: MarketPackageIdentity
		latest: string | null
		label: string
		/** A named field contributes its exact version to the enclosing installation form. */
		name?: string
		/** null prefers the registry latest only when it is present on this checked page. */
		value: string | null
		onChange(version: string): void
		onPageChange?(): void
		disabled?: boolean
	}>) {
	const [cursors, setCursors] = useState<string[]>([])
	const cursor = cursors.at(-1)
	const id = useId()
	return (
		<data.Releases
			identity={identity}
			query={{ registry: identity.registry, limit: 20, ...(cursor ? { cursor } : {}) }}
		>
			{(read) => {
				const page = read.data?.ok ? read.data.value : undefined
				const versions = page?.releases.map((item) => item.version) ?? []
				const preferred = latest && versions.includes(latest) ? latest : ''
				const selected = value ?? preferred
				// A version explicitly chosen on another page stays in the editable selection.
				if (value && !versions.includes(value)) versions.unshift(value)
				const changePage = (next: string[]) => {
					if (value === null && selected) onChange(selected)
					onPageChange?.()
					setCursors(next)
				}
				return (
					<div className="pm-version-picker">
						<ReadStatus
							query={read}
							title="Versions unavailable"
							loadingLabel="Loading package versions"
							retryLabel="Retry versions"
						/>
						{page && page.releases.length === 0 ? (
							<p className="pm-note">
								{cursor
									? 'No indexed versions on this page.'
									: 'No checked releases are available from this market.'}
							</p>
						) : null}
						{page && versions.length > 0 ? (
							<div className="pm-field pm-version-field">
								<label htmlFor={id} className={name ? 'pm-sr-only' : undefined}>
									{label}
								</label>
								<select
									id={id}
									name={name}
									required={Boolean(name)}
									value={selected}
									disabled={disabled || read.isFetching || Boolean(errorOf(read))}
									onChange={(event) => onChange(event.currentTarget.value)}
								>
									<option value="">Select a version</option>
									{versions.map((version) => {
										const notes = [
											version === latest ? 'registry latest' : null,
											versionNote?.({ ...identity, version }),
										].filter(Boolean)
										return (
											<option key={version} value={version}>
												{notes.length > 0 ? version + ' (' + notes.join(', ') + ')' : version}
											</option>
										)
									})}
								</select>
							</div>
						) : null}
						{page && (cursor || page.nextCursor) ? (
							<Pagination
								page={cursors.length + 1}
								busy={read.isFetching || Boolean(disabled)}
								previous={Boolean(cursor)}
								next={Boolean(page.nextCursor)}
								suffix=" versions"
								onPrevious={() => changePage(cursors.slice(0, -1))}
								onNext={() => {
									if (page.nextCursor) changePage([...cursors, page.nextCursor])
								}}
							/>
						) : null}
					</div>
				)
			}}
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
	releaseAction,
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
		<section className="pm-release" aria-label="Release details">
			<div className="pm-between">
				<h3>
					{selection.name}@{selection.version}
				</h3>
				<div className="pm-inline">
					{release && !query.isFetching && !errorOf(query) ? releaseAction?.(release) : null}
					<button type="button" className="pm-button pm-quiet" onClick={onClose}>
						Close details
					</button>
				</div>
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
						<dl className="pm-facts">
							<Fact label="Registry">
								<code>{release.registry}</code>
							</Fact>
							{release.license ? <Fact label="License">{release.license}</Fact> : null}
						</dl>
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
						<section className="pm-document" aria-label="Release README">
							<p className="pm-document-source">README from the checked package archive.</p>
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
	const githubName = /^https:\/\/github\.com\/([^/?#]+\/[^/?#]+)/i.exec(pkg.repository)?.[1]
	return (
		<div className="pm-repository">
			<a
				className="pm-truncate"
				href={pkg.repository}
				title={pkg.repository}
				target="_blank"
				rel="noopener noreferrer"
			>
				{githubName ?? 'Repository'}
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
			<dt>{label}</dt>
			<dd>{children}</dd>
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
