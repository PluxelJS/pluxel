import { isPackageName } from '../package-document.ts'
import { PackageDocumentExplorer } from './package-document-explorer.tsx'
import { NpmDocumentReader } from './npm-package-document.tsx'
import {
	PackageViewer,
	PackageName,
	Fact,
	TabBar,
	DependencyList,
	scrollContainer,
} from './package-viewer.tsx'
import {
	createContext,
	useContext,
	useCallback,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type ReactNode,
	type ComponentType,
} from 'react'
import { satisfies, validRange } from 'semver'
import {
	marketFilterLimit,
	publicRegistry,
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
import { Readme, useReadme } from './marketplace-readme.tsx'

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
	/** An independent action beside the package title in the given surface. */
	packageAction?(pkg: MarketPackageSummary, surface: 'card' | 'detail'): ReactNode
	/** Actions for the exact release currently displayed after a successful read. */
	releaseAction?(release: MarketRelease): ReactNode
	/** Optional host-specific annotation beside an exact version. */
	versionNote?(selection: MarketReleaseIdentity): string | undefined
	/** Reports opening a package or returning to the catalog within this instance. */
	onPackageChange?(selection: MarketPackageIdentity | null): void
	/** Fixed appearance for this surface. @defaultValue 'light' */
	colorScheme?: 'light' | 'dark' | 'auto'
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

type ReturnPosition = { button: HTMLButtonElement; scroll: Element | null; top: number }
type Dependency = { range: string; mode: 'required' | 'optional' | 'peer' }
type PackageVisit = {
	dependency?: Dependency
	pkg: MarketPackageIdentity
	summary?: MarketPackageSummary
	origin: ReturnPosition
}
const DependencyNavigation = createContext<
	| ((identity: MarketPackageIdentity, button: HTMLButtonElement, dependency: Dependency) => void)
	| null
>(null)

function DependencyLink({ name, registry, range, mode }: MarketPackageIdentity & Dependency) {
	const open = useContext(DependencyNavigation)!
	return (
		<button
			type="button"
			className="pm-dependency-link"
			onClick={(event) => open({ name, registry }, event.currentTarget, { range, mode })}
		>
			<code>{name}</code>
		</button>
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
	const [npmPackage, setNpmPackage] = useState<string>()
	const npmTrigger = useRef<HTMLButtonElement>(null)
	const [search, setSearch] = useState('')
	const [selection, setSelection] = useState(emptySelection)
	const [official, setOfficial] = useState<boolean>()
	const [cursors, setCursors] = useState<string[]>([])
	const [visits, setVisits] = useState<PackageVisit[]>([])
	const selectedPackage = visits.at(-1)?.pkg
	const catalog = useRef<HTMLDivElement>(null)
	const details = useRef<HTMLDivElement>(null)
	const searchInput = useRef<HTMLInputElement>(null)
	const returnTo = useRef<ReturnPosition | 'results'>(undefined)
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
	const openVisit = useCallback(
		(
			identity: MarketPackageIdentity,
			button: HTMLButtonElement,
			dependency?: Dependency,
			summary?: MarketPackageSummary,
		) => {
			const index = visits.findIndex(
				({ pkg }) => pkg.name === identity.name && pkg.registry === identity.registry,
			)
			if (index === visits.length - 1 && index >= 0) return
			const scroll = scrollContainer(button)
			const origin = { button, scroll, top: scroll?.scrollTop ?? 0 }
			setVisits(
				index >= 0
					? visits.slice(0, index + 1)
					: [...visits, { pkg: identity, summary, origin, dependency }],
			)
			onPackageChange?.({ name: identity.name, registry: identity.registry })
		},
		[visits, onPackageChange],
	)
	const openPackage = (pkg: MarketPackageSummary, button: HTMLButtonElement) =>
		openVisit({ registry: pkg.registry, name: pkg.name }, button, undefined, pkg)
	const closePackage = () => {
		returnTo.current = visits.at(-1)?.origin
		const remaining = visits.slice(0, -1)
		setVisits(remaining)
		onPackageChange?.(remaining.at(-1)?.pkg ?? null)
	}
	const authorSelected = (author: MarketPackageSummary['author']) =>
		selection.authors.some(({ value }) => value === author?.id)
	const toggleOwner = (author: NonNullable<MarketPackageSummary['author']>) =>
		toggle('authors', { value: author.id, label: author.name, avatarUrl: author.avatarUrl })
	const ownerLimit = selection.authors.length >= marketFilterLimit

	useLayoutEffect(() => {
		if (selectedPackage && !returnTo.current) {
			details.current?.scrollIntoView?.({ block: 'start', inline: 'nearest' })
			const target = visits.at(-1)?.summary
				? details.current?.querySelector<HTMLButtonElement>('.pm-back')
				: details.current
			target?.focus({ preventScroll: true })
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
	}, [selectedPackage, scrollToCatalog, visits])

	useLayoutEffect(() => {
		const element = details.current
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
			closePackage()
		}
		element.addEventListener('keydown', returnOnEscape)
		return () => element.removeEventListener('keydown', returnOnEscape)
	}, [closePackage])
	return (
		<>
			<div className="pm-catalog" ref={catalog} hidden={Boolean(selectedPackage || npmPackage)}>
				<data.Facets filters={filters}>
					{(read) => (
						<CatalogFilters
							read={read}
							query={query}
							search={search}
							onSearch={setSearch}
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
									{isPackageName(query) &&
									!page?.packages.some(
										(pkg) => pkg.name === query && pkg.registry === publicRegistry,
									) ? (
										<button
											type="button"
											ref={npmTrigger}
											className="pm-button"
											onClick={() => setNpmPackage(query)}
										>
											Look up {query} on public npm
										</button>
									) : null}
									{page?.packages.length ? (
										<ul className="pm-results" aria-label="Plugin catalog">
											{page.packages.map((pkg) => (
												<PackageCard
													key={JSON.stringify([pkg.registry, pkg.name])}
													pkg={pkg}
													action={packageAction?.(pkg, 'card')}
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
			{npmPackage && (
				<PackageDocumentExplorer
					key={npmPackage}
					name={npmPackage}
					source="Public npm"
					reader={NpmDocumentReader}
					backLabel="Back to packages"
					onClose={() => {
						setNpmPackage(undefined)
						requestAnimationFrame(() => npmTrigger.current?.focus())
					}}
				/>
			)}
			<DependencyNavigation.Provider value={openVisit}>
				{visits.map(({ pkg, summary, dependency }, index) => (
					<div
						key={JSON.stringify([pkg.registry, pkg.name])}
						className="pm-detail-anchor"
						role="region"
						aria-label={pkg.name}
						tabIndex={-1}
						hidden={pkg !== selectedPackage}
						ref={pkg === selectedPackage ? details : undefined}
					>
						{dependency && index > 0 ? (
							<p className="pm-small pm-muted">
								{
									{ required: 'Required by ', optional: 'Optional for ', peer: 'Peer of ' }[
										dependency.mode
									]
								}
								<code>{visits[index - 1]!.pkg.name}</code> · <code>{dependency.range}</code>
							</p>
						) : null}
						<PackageDetails
							data={data}
							identity={pkg}
							requestedRange={dependency?.range}
							summary={summary}
							packageAction={packageAction}
							releaseAction={releaseAction}
							packageStatus={packageStatus}
							versionNote={
								dependency
									? (selected) => {
											const compatibility =
												validRange(dependency.range) &&
												(satisfies(selected.version, dependency.range) ? 'Matches ' : 'Outside ') +
													dependency.range
											return [compatibility, versionNote?.(selected)].filter(Boolean).join(' · ')
										}
									: versionNote
							}
							onSearchSources={
								pkg.name.length <= 100
									? () => {
											setSelection(emptySelection)
											setOfficial(undefined)
											setCursors([])
											setSearch(pkg.name)
											setQuery(pkg.name)
											returnTo.current = 'results'
											setVisits([])
											onPackageChange?.(null)
										}
									: undefined
							}
							onClose={closePackage}
							backLabel={index ? 'Back to ' + visits[index - 1]!.pkg.name : 'Back to packages'}
							canFilterOwner={(author) => authorSelected(author) || !ownerLimit}
							onFilterOwner={(author) => {
								if (!authorSelected(author)) toggleOwner(author)
								returnTo.current = 'results'
								setVisits([])
								onPackageChange?.(null)
							}}
						/>
					</div>
				))}
			</DependencyNavigation.Provider>
		</>
	)
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

type PackageDetailsProps = BrowseProps &
	Pick<MarketplaceProps, 'packageStatus' | 'packageAction'> &
	Readonly<{
		identity: MarketPackageIdentity
		requestedRange?: string
		summary?: MarketPackageSummary
		backLabel: string
		onSearchSources?: () => void
		onClose(): void
		canFilterOwner(author: NonNullable<MarketPackageSummary['author']>): boolean
		onFilterOwner(author: NonNullable<MarketPackageSummary['author']>): void
	}>

function PackageDetails(props: PackageDetailsProps) {
	const [publicView, setPublicView] = useState(false)
	const lookup = useRef<HTMLButtonElement>(null)
	if (publicView)
		return (
			<PackageDocumentExplorer
				name={props.identity.name}
				range={props.requestedRange}
				source="Public npm"
				reader={NpmDocumentReader}
				backLabel="Back to market details"
				onClose={() => {
					setPublicView(false)
					requestAnimationFrame(() => lookup.current?.focus())
				}}
			/>
		)
	return (
		<props.data.Package identity={props.identity}>
			{(query) => {
				const summary = query.data?.ok ? query.data.value : props.summary
				return summary ? (
					<PackageOverview {...props} pkg={summary} query={query} />
				) : (
					<section className="pm-details" aria-label="Package details">
						<button type="button" className="pm-button pm-quiet pm-back" onClick={props.onClose}>
							{props.backLabel}
						</button>
						<h2>
							<PackageName name={props.identity.name} />
						</h2>
						<p className="pm-muted">{props.identity.registry}</p>
						<ReadStatus
							query={query}
							title="Dependency details unavailable"
							loadingLabel="Loading dependency details"
							retryLabel="Retry package"
						/>
						{query.data?.ok === false && query.data.error.code === 'NOT_INDEXED' ? (
							<div className="pm-detail-actions">
								{props.onSearchSources && (
									<button className="pm-button" type="button" onClick={props.onSearchSources}>
										Search all sources
									</button>
								)}
								<button
									className="pm-button"
									type="button"
									ref={lookup}
									onClick={() => setPublicView(true)}
								>
									Look up {props.identity.name} on public npm
								</button>
							</div>
						) : null}
					</section>
				)
			}}
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
	backLabel,
	onClose,
	canFilterOwner,
	onFilterOwner,
	query,
}: PackageDetailsProps &
	Readonly<{ pkg: MarketPackageSummary; query: MarketplaceRead<MarketPackageDetail> }>) {
	const detail = query.data?.ok ? query.data.value : undefined
	const summary = detail ?? pkg
	const [tab, setTab] = useState('overview')
	const readme = useReadme(tab === 'overview' ? detail?.readme : undefined)
	const identity = { registry: pkg.registry, name: pkg.name }
	return (
		<PackageViewer
			name={pkg.name}
			description={summary.description}
			backLabel={backLabel}
			onClose={onClose}
			metadata={
				<>
					{' '}
					{summary.latest ? (
						<span className="pm-latest" title={'Registry latest: ' + summary.latest}>
							<span>latest</span> <code className="pm-truncate">{summary.latest}</code>
						</span>
					) : null}
					{summary.official ? <span className="pm-badge pm-official">Official</span> : null}
				</>
			}
			actions={
				<>
					{packageStatus?.(summary)}
					{summary.indexedVersions === 0 ? (
						<span className="pm-no-release">No checked releases</span>
					) : null}
					{packageAction?.(summary, 'detail')}
				</>
			}
			navigation={
				<TabBar
					value={tab}
					onChange={setTab}
					label="Package information"
					tabs={['Overview', 'Versions']}
				/>
			}
		>
			<div className="pm-overview">
				<PackageSidebar
					summary={summary}
					detail={detail}
					showRequirements={tab === 'overview'}
					headings={readme.headings}
					canFilterOwner={canFilterOwner}
					onFilterOwner={onFilterOwner}
				/>
				{tab === 'overview' ? (
					<section className="pm-document" aria-label="Registry README">
						<ReadStatus
							query={query}
							title="Package details unavailable"
							loadingLabel="Loading package details"
							retryLabel="Retry package"
						/>
						{detail ? (
							<>
								<h3>Registry README</h3>
								{readme.body}
							</>
						) : null}
					</section>
				) : (
					<ReleaseVersions
						data={data}
						identity={identity}
						latest={summary.latest}
						distTags={detail?.distTags}
						releaseAction={releaseAction}
						versionNote={versionNote}
					/>
				)}
			</div>
		</PackageViewer>
	)
}

function PackageSidebar({
	summary,
	detail,
	showRequirements,
	headings,
	canFilterOwner,
	onFilterOwner,
}: Pick<PackageDetailsProps, 'canFilterOwner' | 'onFilterOwner'> &
	Readonly<{
		summary: MarketPackageSummary
		detail?: MarketPackageDetail
		showRequirements: boolean
		headings: ReturnType<typeof useReadme>['headings']
	}>) {
	const [expanded, setExpanded] = useState(false)
	const id = useId()
	const { author, category, tags } = summary
	const requirements = showRequirements ? detail?.checkedRequirements : undefined
	const plugins = Object.entries(requirements?.pluginPackages ?? {}).sort(([a], [b]) =>
		a.localeCompare(b),
	)
	const distTags = Object.entries(detail?.distTags ?? {})
	const hasOtherTags = distTags.some(([tag]) => tag !== 'latest')
	return (
		<aside className="pm-package-meta" aria-label="Plugin details" data-expanded={expanded}>
			<button
				type="button"
				className="pm-meta-toggle"
				aria-controls={id}
				aria-expanded={expanded}
				onClick={() => setExpanded(!expanded)}
			>
				Plugin details
			</button>
			<div id={id} className="pm-meta-content">
				<section>
					<h3>Plugin details</h3>
					<dl className="pm-facts">
						{category ? <Fact label="Category">{categoryLabel(category)}</Fact> : null}
						<Fact label="Owner">
							{author ? (
								<button
									type="button"
									className="pm-text-action pm-author pm-owner-link"
									aria-label={'Show packages from repository owner ' + author.name}
									disabled={!canFilterOwner(author)}
									onClick={() => onFilterOwner(author)}
								>
									<AuthorAvatar url={author.avatarUrl} />
									{author.name}
								</button>
							) : (
								<span className="pm-owner-unknown">Repository owner unavailable</span>
							)}
						</Fact>
						{summary.repository ? (
							<Fact label="Repository">
								<RepositoryLink pkg={summary} />
							</Fact>
						) : null}
						{detail?.license ? <Fact label="License">{detail.license}</Fact> : null}
					</dl>
					{tags.length > 0 ? (
						<div className="pm-tags">
							{tags.map((tag) => (
								<span key={tag} className="pm-chip">
									#{tag}
								</span>
							))}
						</div>
					) : null}
				</section>
				{requirements ? (
					<section aria-label="Plugin requirements">
						<h3>
							Requirements <code>{requirements.version}</code>
						</h3>
						<dl className="pm-facts">
							{requirements.peerDependencies['@pluxel/core'] ? (
								<Fact label="Pluxel core">
									<code>{requirements.peerDependencies['@pluxel/core']}</code>
								</Fact>
							) : null}
							{plugins.map(([name, mode]) => (
								<div key={name} className="pm-plugin-dependency">
									<dt>
										<DependencyLink
											name={name}
											registry={summary.registry}
											mode={mode}
											range={requirements.peerDependencies[name]}
										/>
									</dt>
									<dd>
										<code>{requirements.peerDependencies[name]}</code>
										<span className="pm-badge">{mode}</span>
									</dd>
								</div>
							))}
						</dl>
						{plugins.length === 0 ? (
							<p className="pm-coverage">No plugin dependencies declared.</p>
						) : null}
					</section>
				) : null}
				<section>
					<h3>Registry</h3>
					<dl className="pm-facts">
						<Fact label="Source">
							<code title={summary.registry}>{registryLabel(summary.registry)}</code>
						</Fact>
						{detail?.metadataVersion ? (
							<Fact label="Metadata version">
								<code>{detail.metadataVersion}</code>
							</Fact>
						) : null}
						<Fact label="Checked releases">{summary.indexedVersions}</Fact>
						{detail ? (
							<Fact label="Last observed">{new Date(detail.observedAt).toLocaleDateString()}</Fact>
						) : null}
					</dl>
					{summary.indexedVersions === 0 ? (
						<p className="pm-coverage">No checked releases are available from this market.</p>
					) : null}
					{hasOtherTags ? (
						<details className="pm-dist-tags">
							<summary>Distribution tags ({distTags.length})</summary>
							<dl className="pm-facts">
								{distTags.map(([tag, version]) => (
									<Fact key={tag} label={tag}>
										<code>{version}</code>
									</Fact>
								))}
							</dl>
						</details>
					) : null}
					{detail ? (
						<NpmxLink
							registry={detail.registry}
							name={detail.name}
							version={detail.metadataVersion}
						/>
					) : null}
				</section>
				{headings.length > 1 ? (
					<nav className="pm-readme-outline" aria-label="In this README">
						<h3>In this README</h3>
						{headings.map((heading) => (
							<button
								key={heading.id}
								type="button"
								data-depth={heading.depth}
								aria-controls={heading.id}
								onClick={(event) => {
									const root = event.currentTarget.getRootNode() as Document | ShadowRoot
									const target = root.getElementById(heading.id)
									target?.focus({ preventScroll: true })
									target?.scrollIntoView({ block: 'start', inline: 'nearest' })
								}}
							>
								{heading.label}
							</button>
						))}
					</nav>
				) : null}
			</div>
		</aside>
	)
}

function ReleaseVersions({
	data,
	identity,
	latest,
	distTags,
	releaseAction,
	versionNote,
}: BrowseProps &
	Readonly<{
		identity: MarketPackageIdentity
		latest: string | null
		distTags?: Readonly<Record<string, string>>
	}>) {
	const [expanded, setExpanded] = useState('')
	const listId = useId()
	return (
		<section className="pm-versions" aria-label="Available package versions">
			<h3>Checked releases</h3>
			{!latest && <p className="pm-small pm-muted">The registry has no latest release.</p>}
			<ReleasePages data={data} identity={identity} onPageChange={() => setExpanded('')}>
				{(page, unavailable) =>
					page.releases.length > 0 ? (
						<ul className="pm-release-list" aria-label="Checked releases">
							{page.releases.map(({ version, checkedAt }, index) => {
								const open = expanded === version
								const panelId = listId + '-' + index
								const note = versionNote?.({ ...identity, version })
								const tags = Object.entries(distTags ?? {})
									.filter(([, tagged]) => tagged === version)
									.map(([tag]) => tag)
								if (version === latest && !tags.includes('latest')) tags.unshift('latest')
								const checked = new Date(checkedAt)
								return (
									<li key={version}>
										<button
											type="button"
											className="pm-release-row"
											aria-expanded={open}
											aria-controls={open ? panelId : undefined}
											disabled={unavailable}
											onClick={() => setExpanded(open ? '' : version)}
										>
											<span className="pm-release-identity">
												<code>{version}</code>
												{tags.map((tag) => (
													<span key={tag} className="pm-badge">
														{tag}
													</span>
												))}
												{note ? <span className="pm-version-note">{note}</span> : null}
											</span>
											<time
												dateTime={checked.toJSON() ?? undefined}
												title={checked.toLocaleString()}
											>
												Checked {checked.toLocaleDateString()}
											</time>
										</button>
										{open && (
											<div id={panelId}>
												<ReleaseDetails
													data={data}
													selection={{ ...identity, version }}
													releaseAction={unavailable ? undefined : releaseAction}
												/>
											</div>
										)}
									</li>
								)
							})}
						</ul>
					) : (
						<NpmxLink {...identity} version={latest} />
					)
				}
			</ReleasePages>
		</section>
	)
}

function ReleasePages({
	data,
	identity,
	disabled,
	onPageChange,
	children,
}: Readonly<{
	data: MarketplaceData
	identity: MarketPackageIdentity
	disabled?: boolean
	onPageChange(page: MarketReleasePage): void
	children(page: MarketReleasePage, unavailable: boolean): ReactNode
}>) {
	const [cursors, setCursors] = useState<string[]>([])
	const cursor = cursors.at(-1)
	return (
		<data.Releases
			identity={identity}
			query={{ registry: identity.registry, limit: 20, ...(cursor ? { cursor } : {}) }}
		>
			{(read) => {
				const page = read.data?.ok ? read.data.value : undefined
				const unavailable = Boolean(disabled || read.isFetching || errorOf(read))
				function changePage(next: string[]) {
					if (!page) return
					onPageChange(page)
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
						{page && children(page, unavailable)}
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

/** Named field for one exact version in the installation draft. */
export function MarketVersionPicker({
	data,
	identity,
	latest,
	versionNote,
	name,
	value,
	onChange,
	disabled,
}: Pick<MarketplaceProps, 'data' | 'versionNote'> &
	Readonly<{
		identity: MarketPackageIdentity
		latest: string | null
		name: string
		value: string | null
		onChange(version: string): void
		disabled?: boolean
	}>) {
	const id = useId()
	const preferred = (page: MarketReleasePage) =>
		latest && page.releases.some((item) => item.version === latest) ? latest : ''
	return (
		<ReleasePages
			data={data}
			identity={identity}
			disabled={disabled}
			onPageChange={(page) => {
				const version = preferred(page)
				if (value === null && version) onChange(version)
			}}
		>
			{(page, unavailable) => {
				const versions = page.releases.map((item) => item.version)
				if (value && !versions.includes(value)) versions.unshift(value)
				if (versions.length === 0) return null
				return (
					<div className="pm-field pm-version-field">
						<label htmlFor={id}>
							Install version<span className="pm-sr-only"> for {identity.name}</span>
						</label>
						<select
							id={id}
							name={name}
							required
							value={value ?? preferred(page)}
							disabled={unavailable}
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
				)
			}}
		</ReleasePages>
	)
}

function ReleaseDetails(props: BrowseProps & Readonly<{ selection: MarketReleaseIdentity }>) {
	return (
		<props.data.Release identity={props.selection}>
			{(query) => <ReleaseOverview {...props} query={query} />}
		</props.data.Release>
	)
}

function ReleaseOverview({
	selection,
	releaseAction,
	query,
}: BrowseProps &
	Readonly<{
		selection: MarketReleaseIdentity
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
	if (registry !== publicRegistry || !version) return null
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

function Dependencies({ release }: { release: MarketRelease }) {
	const names = [
		...new Set([...Object.keys(release.peerDependencies), ...Object.keys(release.pluginPackages)]),
	].sort()
	return (
		<DependencyList
			items={names.map((name) => {
				const mode = release.pluginPackages[name]
				const range = release.peerDependencies[name]
				return {
					name,
					range,
					kind: mode ? mode + ' plugin' : 'Peer',
					link: (
						<DependencyLink
							name={name}
							registry={release.registry}
							mode={mode ?? 'peer'}
							range={range}
						/>
					),
				}
			})}
		/>
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
