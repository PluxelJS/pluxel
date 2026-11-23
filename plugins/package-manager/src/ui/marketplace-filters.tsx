import { useEffect, useId, useRef, useState, type RefObject } from 'react'
import { marketFilterLimit, type MarketCatalogFacets } from '../market-contracts.ts'
import type { MarketplaceRead } from './marketplace.tsx'

export const catalogFacets = ['authors', 'categories', 'tags', 'registries'] as const
export type CatalogFacet = (typeof catalogFacets)[number]
type Choice = Readonly<{ value: string; label: string; avatarUrl?: string | null }>
type CountedChoice = Choice & Readonly<{ count: number }>
export type CatalogSelection = Readonly<Record<CatalogFacet, readonly Choice[]>>
export const emptySelection: CatalogSelection = {
	authors: [],
	categories: [],
	tags: [],
	registries: [],
}

const labels: Record<CatalogFacet, string> = {
	authors: 'Repository owners',
	categories: 'Categories',
	tags: 'Tags',
	registries: 'Sources',
}

export function registryLabel(value: string) {
	return value === 'https://registry.npmjs.org' ? 'npm' : value.replace(/^https:\/\//, '')
}

export function categoryLabel(value: string) {
	return value
		.split('-')
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(' ')
}

function choicesFor(data: MarketCatalogFacets | undefined, facet: CatalogFacet): CountedChoice[] {
	if (!data) return []
	if (facet === 'authors') {
		return data.authors.map(({ id, name, avatarUrl, count }) => ({
			value: id,
			label: name,
			avatarUrl,
			count,
		}))
	}
	return data[facet].map(({ value, count }) => ({
		value,
		label:
			facet === 'registries'
				? registryLabel(value)
				: facet === 'categories'
					? categoryLabel(value)
					: '#' + value,
		count,
	}))
}

export function AuthorAvatar({ url }: Readonly<{ url: string | null | undefined }>) {
	return url ? (
		<img
			key={url}
			className="pm-avatar"
			src={url}
			alt=""
			width={20}
			height={20}
			loading="lazy"
			decoding="async"
			referrerPolicy="no-referrer"
			onError={(event) => {
				event.currentTarget.hidden = true
			}}
		/>
	) : null
}

const visibleOptionCount = 5

function FacetGroup({
	facet,
	available,
	active,
	showCounts,
	onToggle,
}: Readonly<{
	facet: CatalogFacet
	available: readonly CountedChoice[]
	active: readonly Choice[]
	showCounts: boolean
	onToggle(choice: Choice): void
}>) {
	const [search, setSearch] = useState('')
	const [expanded, setExpanded] = useState(false)
	const label = labels[facet]
	// Other active facets may remove a selected value from the server's counts.
	const options = [
		...active
			.filter(({ value }) => !available.some((item) => item.value === value))
			.map((item) => ({
				value: item.value,
				label: item.label,
				avatarUrl: item.avatarUrl,
				count: 0,
			})),
		...available,
	]
	const searchable = options.length > visibleOptionCount
	const term = search.trim().toLowerCase()
	const matches =
		searchable && term ? options.filter((item) => item.label.toLowerCase().includes(term)) : options
	const shown = expanded ? matches : matches.slice(0, visibleOptionCount)
	return (
		<details className="pm-facet" open>
			<summary>{label}</summary>
			<div role="group" aria-label={label} className="pm-filter-options">
				{searchable ? (
					<input
						type="search"
						aria-label={'Find ' + label.toLowerCase()}
						placeholder={'Find ' + label.toLowerCase()}
						value={search}
						onChange={(event) => setSearch(event.currentTarget.value)}
					/>
				) : null}
				{shown.map(({ count, ...choice }) => {
					const checked = active.some(({ value }) => value === choice.value)
					return (
						<label key={choice.value} className="pm-filter-option">
							<input
								type="checkbox"
								checked={checked}
								disabled={!checked && active.length >= marketFilterLimit}
								onChange={() => onToggle(choice)}
							/>
							<AuthorAvatar url={choice.avatarUrl} />
							<span className="pm-truncate" title={choice.label}>
								{choice.label}
							</span>
							{showCounts ? (
								<span className="pm-option-count" aria-hidden="true">
									{count}
								</span>
							) : null}
						</label>
					)
				})}
				{matches.length === 0 && showCounts ? (
					<p className="pm-small pm-muted">No matching {label.toLowerCase()}.</p>
				) : null}
				{matches.length > visibleOptionCount ? (
					<button
						type="button"
						className="pm-side-more"
						aria-expanded={expanded}
						onClick={() => setExpanded(!expanded)}
					>
						{expanded ? 'Show fewer' : 'Show ' + (matches.length - visibleOptionCount) + ' more'}
					</button>
				) : null}
				{active.length === marketFilterLimit ? (
					<p className="pm-small pm-muted">Up to {marketFilterLimit} choices per filter.</p>
				) : null}
			</div>
		</details>
	)
}

export function CatalogFilters({
	read,
	selection,
	official,
	query,
	searchInput,
	onQuery,
	onToggle,
	onOfficial,
	onClear,
}: Readonly<{
	read: MarketplaceRead<MarketCatalogFacets>
	selection: CatalogSelection
	official?: boolean
	query: string
	searchInput: RefObject<HTMLInputElement | null>
	onQuery(query: string): void
	onToggle(facet: CatalogFacet, choice: Choice): void
	onOfficial(value: boolean | undefined): void
	onClear(): void
}>) {
	const id = useId()
	const [search, setSearch] = useState(query)
	const [compactOpen, setCompactOpen] = useState(false)
	const [showAll, setShowAll] = useState(false)
	const trigger = useRef<HTMLButtonElement>(null)
	const sidebar = useRef<HTMLElement>(null)
	const current = read.data?.ok ? read.data.value : undefined
	const [previous, setPrevious] = useState<MarketCatalogFacets>()
	const choices = current ?? previous

	useEffect(() => {
		const next = search.trim()
		if (next === query) return undefined
		const timer = setTimeout(() => onQuery(next), 200)
		return () => clearTimeout(timer)
	}, [search, query, onQuery])

	useEffect(() => {
		if (current) setPrevious(current)
	}, [current])

	useEffect(() => {
		const button = trigger.current
		if (!compactOpen || !button) return undefined
		const ownerDocument = button.ownerDocument
		function escape(event: KeyboardEvent) {
			if (event.key !== 'Escape' || !button?.getClientRects().length) return
			if (
				ownerDocument.activeElement !== button &&
				!sidebar.current?.contains(ownerDocument.activeElement)
			)
				return
			event.preventDefault()
			event.stopPropagation()
			setCompactOpen(false)
			button.focus()
		}
		ownerDocument.addEventListener('keydown', escape, true)
		return () => ownerDocument.removeEventListener('keydown', escape, true)
	}, [compactOpen])

	const chips = catalogFacets.flatMap((key) => selection[key].map((choice) => ({ key, choice })))
	const filterCount = chips.length + Number(official !== undefined)
	const panelId = id + '-catalog-filters'
	const failed = Boolean(read.error || read.data?.ok === false)
	const showChips = showAll ? chips : chips.slice(0, 3)

	return (
		<>
			<div className="pm-toolbar">
				<form
					className="pm-search"
					role="search"
					onSubmit={(event) => {
						event.preventDefault()
						if (search.trim() !== query) onQuery(search.trim())
					}}
				>
					<label htmlFor={id + '-search'} className="pm-sr-only">
						Search packages
					</label>
					<input
						id={id + '-search'}
						ref={searchInput}
						type="search"
						placeholder="Search packages"
						maxLength={100}
						value={search}
						onChange={(event) => setSearch(event.currentTarget.value)}
					/>
					{search ? (
						<button
							type="button"
							className="pm-clear-search"
							aria-label="Clear search"
							onClick={() => {
								setSearch('')
								onQuery('')
								searchInput.current?.focus()
							}}
						>
							×
						</button>
					) : null}
				</form>
				<span className="pm-catalog-count pm-small pm-muted" role="status">
					{current ? current.total + (current.total === 1 ? ' package' : ' packages') : ''}
				</span>
				<button
					type="button"
					ref={trigger}
					className="pm-button pm-compact-filters"
					aria-expanded={compactOpen}
					aria-controls={panelId}
					onClick={() => setCompactOpen(!compactOpen)}
				>
					Filters{filterCount ? ' (' + filterCount + ')' : ''}
				</button>
			</div>
			<aside
				className="pm-filter-sidebar"
				id={panelId}
				aria-label="Catalog filters"
				data-open={compactOpen}
				ref={sidebar}
			>
				<h3 className="pm-sidebar-title">Filters</h3>
				{read.isFetching && !current ? (
					<p className="pm-small pm-muted" role="status">
						Updating choices…
					</p>
				) : null}
				{failed ? (
					<div className="pm-filter-error pm-small" role="alert">
						<span>Filter options unavailable</span>
						<button
							type="button"
							className="pm-side-more"
							disabled={read.isFetching}
							onClick={() => void read.refetch().catch(() => {})}
						>
							Retry filters
						</button>
					</div>
				) : null}
				{catalogFacets.map((facet) => (
					<FacetGroup
						key={facet}
						facet={facet}
						active={selection[facet]}
						available={choicesFor(choices, facet)}
						showCounts={Boolean(current)}
						onToggle={(choice) => onToggle(facet, choice)}
					/>
				))}
				<details className="pm-facet" open>
					<summary>Official status</summary>
					<div className="pm-filter-options" role="group" aria-label="Official status">
						{(['All packages', 'Official', 'Community'] as const).map((label, index) => {
							const value = index === 0 ? undefined : index === 1
							return (
								<label className="pm-filter-option" key={label}>
									<input
										type="radio"
										name={id + '-official'}
										checked={official === value}
										onChange={() => onOfficial(value)}
									/>
									<span>{label}</span>
								</label>
							)
						})}
					</div>
				</details>
			</aside>
			{filterCount ? (
				<div className="pm-selected-filters" aria-label="Applied filters">
					{showChips.map(({ key, choice }) => (
						<button
							type="button"
							key={key + ':' + choice.value}
							className="pm-chip pm-applied-filter"
							aria-label={'Remove ' + choice.label}
							onClick={() => onToggle(key, choice)}
						>
							<span className="pm-truncate">{choice.label}</span>
							<span aria-hidden="true">×</span>
						</button>
					))}
					{chips.length > 3 ? (
						<button
							type="button"
							className="pm-button pm-quiet"
							aria-expanded={showAll}
							onClick={() => setShowAll(!showAll)}
						>
							{showAll ? 'Show fewer' : '+' + (chips.length - 3) + ' filters'}
						</button>
					) : null}
					{official !== undefined ? (
						<button
							type="button"
							className="pm-chip pm-applied-filter"
							aria-label="Remove official status filter"
							onClick={() => onOfficial(undefined)}
						>
							{official ? 'Official' : 'Community'} <span aria-hidden="true">×</span>
						</button>
					) : null}
					<button type="button" className="pm-button pm-quiet" onClick={onClear}>
						Clear filters
					</button>
				</div>
			) : null}
		</>
	)
}
