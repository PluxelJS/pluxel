import { useEffect, useId, useRef, useState, type MouseEvent, type RefObject } from 'react'
import { marketFilterLimit, type MarketCatalogFacets } from '../market-contracts.ts'
import type { MarketplaceRead } from './marketplace.tsx'

export const catalogFacets = ['authors', 'categories', 'tags', 'registries'] as const
export type CatalogFacet = (typeof catalogFacets)[number]
type Filter = CatalogFacet | 'official'
const filters = [...catalogFacets, 'official'] as const
type Choice = Readonly<{ value: string; label: string; avatarUrl?: string | null }>
type CountedChoice = Choice & Readonly<{ count: number }>
export type CatalogSelection = Readonly<Record<CatalogFacet, readonly Choice[]>>
export const emptySelection: CatalogSelection = {
	authors: [],
	categories: [],
	tags: [],
	registries: [],
}

const labels: Record<Filter, string> = {
	authors: 'Authors',
	categories: 'Categories',
	tags: 'Tags',
	registries: 'Sources',
	official: 'Official status',
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
	const [facet, setFacet] = useState<Filter>()
	const [choiceSearch, setChoiceSearch] = useState('')
	const [showAll, setShowAll] = useState(false)
	const host = useRef<HTMLDivElement>(null)
	const panel = useRef<HTMLElement>(null)
	const trigger = useRef<HTMLButtonElement>(null)
	const current = read.data?.ok ? read.data.value : undefined
	const [previous, setPrevious] = useState<MarketCatalogFacets>()
	const open = facet !== undefined

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
		if (!open) return undefined
		const document = host.current?.ownerDocument
		if (!document) return undefined
		panel.current?.focus()
		const dismiss = (event: PointerEvent) => {
			if (event.target instanceof Node && !host.current?.contains(event.target)) setFacet(undefined)
		}
		const escape = (event: KeyboardEvent) => {
			if (event.key !== 'Escape' || !host.current?.contains(document.activeElement)) return
			event.preventDefault()
			event.stopPropagation()
			setFacet(undefined)
			trigger.current?.focus()
		}
		document.addEventListener('pointerdown', dismiss)
		document.addEventListener('keydown', escape, true)
		return () => {
			document.removeEventListener('pointerdown', dismiss)
			document.removeEventListener('keydown', escape, true)
		}
	}, [open])

	const chips = catalogFacets.flatMap((key) => selection[key].map((choice) => ({ key, choice })))
	const filterCount = chips.length + Number(official !== undefined)
	const panelId = id + '-catalog-filters'
	const openFacet = (event: MouseEvent<HTMLButtonElement>, next: Filter) => {
		trigger.current = event.currentTarget
		setFacet(next === facet ? undefined : next)
		setChoiceSearch('')
	}
	const switchFacet = (next: Filter) => {
		setFacet(next)
		setChoiceSearch('')
	}
	const active = facet && facet !== 'official' ? selection[facet] : []
	const available = facet && facet !== 'official' ? choicesFor(current ?? previous, facet) : []
	const options = [
		...active
			.filter((item) => !available.some(({ value }) => value === item.value))
			.map(({ value, label, avatarUrl }) => ({ value, label, avatarUrl, count: 0 })),
		...available,
	].filter(({ label }) => label.toLowerCase().includes(choiceSearch.trim().toLowerCase()))
	const failed = Boolean(read.error || read.data?.ok === false)
	const showChips = showAll ? chips : chips.slice(0, 3)

	return (
		<div className="pm-controls">
			<div className="pm-controls-inner" ref={host}>
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
								className="pm-clear-search"
								type="button"
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
					<div className="pm-wide-filters" aria-label="Filters">
						{filters.map((key) => (
							<button
								key={key}
								type="button"
								className="pm-button pm-facet-trigger"
								aria-expanded={facet === key}
								aria-controls={open ? panelId : undefined}
								onClick={(event) => openFacet(event, key)}
							>
								{key === 'official' && official !== undefined
									? official
										? 'Official'
										: 'Community'
									: labels[key]}
								{key !== 'official' && selection[key].length > 0 ? (
									<span>{selection[key].length}</span>
								) : null}
							</button>
						))}
					</div>
					<button
						type="button"
						className="pm-button pm-facet-trigger pm-compact-filters"
						aria-expanded={open}
						aria-controls={open ? panelId : undefined}
						onClick={(event) => {
							trigger.current = event.currentTarget
							setFacet(open ? undefined : 'authors')
							setChoiceSearch('')
						}}
					>
						Filters{filterCount ? ' (' + filterCount + ')' : ''}
					</button>
				</div>
				{facet ? (
					<section
						id={panelId}
						ref={panel}
						className="pm-filter-panel"
						aria-label={labels[facet] + ' filter'}
						tabIndex={-1}
					>
						<select
							className="pm-filter-switcher"
							aria-label="Filter by"
							value={facet}
							onChange={(event) => switchFacet(event.currentTarget.value as Filter)}
						>
							{filters.map((key) => (
								<option key={key} value={key}>
									{labels[key]}
								</option>
							))}
						</select>
						{facet === 'official' ? (
							<div className="pm-filter-options">
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
						) : (
							<>
								<input
									type="search"
									aria-label={'Find ' + labels[facet].toLowerCase()}
									placeholder={'Find ' + labels[facet].toLowerCase()}
									value={choiceSearch}
									onChange={(event) => setChoiceSearch(event.currentTarget.value)}
								/>
								{read.isFetching && !current ? (
									<span className="pm-small pm-muted" role="status">
										Updating choices…
									</span>
								) : null}
								{failed ? (
									<div className="pm-between pm-small" role="alert">
										<span>Filter options unavailable</span>
										<button
											type="button"
											className="pm-button pm-quiet"
											disabled={read.isFetching}
											onClick={() => void read.refetch().catch(() => {})}
										>
											Retry filters
										</button>
									</div>
								) : null}
								<div className="pm-filter-options">
									{options.map(({ count, ...choice }) => {
										const checked = active.some(({ value }) => value === choice.value)
										return (
											<label className="pm-filter-option" key={choice.value}>
												<input
													type="checkbox"
													checked={checked}
													disabled={!checked && active.length >= marketFilterLimit}
													onChange={() => onToggle(facet, choice)}
												/>
												<AuthorAvatar url={choice.avatarUrl} />
												<span className="pm-truncate" title={choice.label}>
													{choice.label}
												</span>
												{current ? <span className="pm-option-count">{count}</span> : null}
											</label>
										)
									})}
									{current && options.length === 0 ? (
										<p className="pm-small pm-muted">No matching {labels[facet].toLowerCase()}.</p>
									) : null}
								</div>
								{active.length === marketFilterLimit ? (
									<p className="pm-small pm-muted">Up to {marketFilterLimit} choices per filter.</p>
								) : null}
							</>
						)}
					</section>
				) : null}
			</div>
			<div className="pm-catalog-status">
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
								onClick={() => setShowAll((value) => !value)}
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
				<span className="pm-catalog-count pm-small pm-muted" role="status">
					{current ? current.total + (current.total === 1 ? ' package' : ' packages') : ''}
				</span>
			</div>
		</div>
	)
}
