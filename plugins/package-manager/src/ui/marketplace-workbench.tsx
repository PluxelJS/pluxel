import { PublicPackageLookup } from './npm-package-document.tsx'
import { marketplaceStyles } from './marketplace.styles.ts'
import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { WorkbenchHostFacade } from '@pluxel/workbench/react'
import { versionRelation } from './package-version.ts'
import {
	packageMutationLimit,
	type ManagedPackage,
	type MarketInstallRequest,
	type MarketPackageIdentity,
	type MarketPackageSummary,
	type MarketReleaseIdentity,
	type PackageManagerSnapshot,
} from '../contracts.ts'
import { MarketInstallSelection, type MarketSelectionItem } from './market-install-selection.tsx'
import { Marketplace, type MarketplaceData } from './marketplace.tsx'
import type { PackageUsage } from './package-usage.ts'
import { MarketContext } from './workbench-market-data.tsx'

type WorkbenchMarketplaceProps = Readonly<{
	snapshot: PackageManagerSnapshot
	data: MarketplaceData
	busy: boolean
	items: readonly MarketSelectionItem[]
	onChange(items: readonly MarketSelectionItem[]): void
	onPrepare(requests: readonly MarketInstallRequest[]): void
	usage: readonly PackageUsage[] | null | undefined
	host: WorkbenchHostFacade
	title: string
}>

/** Workbench transport stays inside its existing per-open resource owner. */
export function WorkbenchMarketplace({
	snapshot,
	data,
	busy,
	items,
	onChange,
	onPrepare,
	usage,
	host,
	title,
}: WorkbenchMarketplaceProps) {
	const [selectedMarket, setSelectedMarket] = useState<string>()
	const [openPackage, setOpenPackage] = useState<MarketPackageIdentity | null>(null)
	const { markets } = snapshot
	const market = markets.find((item) => item.id === selectedMarket) ?? markets[0]
	const installations = useMemo(
		() => new Map(snapshot.packages.map((pkg) => [pkg.name, pkg])),
		[snapshot.packages],
	)
	const pendingRemovals = useMemo(
		() => new Set(snapshot.pendingRemovals),
		[snapshot.pendingRemovals],
	)
	const document = host.document
	const id = useId()
	const selectionForm = useRef<HTMLFormElement>(null)
	function viewSelection() {
		selectionForm.current?.scrollIntoView?.({ block: 'start' })
		selectionForm.current?.focus({ preventScroll: true })
	}
	useLayoutEffect(() => {
		if (!document || !openPackage) return undefined
		document.setTitle({ title: openPackage.name, meta: title })
		return () => document.setTitle({ title })
	}, [document, openPackage, title])

	const selectedByName = new Map(items.map((item) => [item.name, item]))
	const usageByName = useMemo(() => new Map(usage?.map((item) => [item.name, item])), [usage])
	function versionNote({ registry, name, version }: MarketReleaseIdentity) {
		const pkg = installations.get(name)
		if (!pkg?.entryFile || pkg.marketRegistry !== registry) return undefined
		const relation = versionRelation(pkg.installedVersion, version)
		if (relation === 'installed') return 'installed here'
		if (relation === 'newer') return 'newer than installed'
		if (relation === 'older') return 'older than installed'
		return undefined
	}
	function selectionBlock(pkg: MarketPackageIdentity) {
		const existing = selectedByName.get(pkg.name)
		if (existing && (existing.marketId !== market?.id || existing.registry !== pkg.registry))
			return (
				'Remove the selection from ' +
				existing.marketId +
				' · ' +
				existing.registry +
				' to choose another source.'
			)
		if (!existing && items.length >= packageMutationLimit)
			return 'Select up to ' + packageMutationLimit + ' packages per installation.'
		return undefined
	}
	function add(pkg: MarketPackageIdentity, latest: string | null, version: string | null) {
		if (!market || busy || selectionBlock(pkg)) return
		const item = { marketId: market.id, name: pkg.name, registry: pkg.registry, latest, version }
		onChange(
			selectedByName.has(pkg.name)
				? items.map((entry) => (entry.name === pkg.name ? item : entry))
				: [...items, item],
		)
	}

	if (!market)
		return (
			<section className="plx-marketplace" data-color-scheme={host.colorScheme}>
				<style>{marketplaceStyles}</style>
				<p className="pm-muted">No market is configured for this application.</p>
				<PublicPackageLookup />
			</section>
		)
	return (
		<div className="plx-marketplace" data-color-scheme={host.colorScheme}>
			<div className="pm-stack">
				{markets.length > 1 ? (
					<div className="pm-field">
						<label htmlFor={id}>Market</label>
						<select
							id={id}
							value={market.id}
							onChange={(event) => {
								setSelectedMarket(event.currentTarget.value)
								setOpenPackage(null)
							}}
						>
							{markets.map((item) => (
								<option key={item.id} value={item.id}>
									{item.id}
								</option>
							))}
						</select>
					</div>
				) : null}
				<MarketInstallSelection
					formRef={selectionForm}
					items={items}
					data={data}
					busy={busy}
					onChange={onChange}
					onPrepare={onPrepare}
					versionNote={versionNote}
				/>
				<MarketContext.Provider value={market.id}>
					<Marketplace
						key={market.id}
						data={data}
						colorScheme={host.colorScheme}
						onPackageChange={setOpenPackage}
						versionNote={versionNote}
						packageAction={(pkg, surface) => {
							const existing = selectedByName.get(pkg.name)
							const selected =
								existing?.marketId === market.id && existing.registry === pkg.registry
							const showChoice = surface === 'card' || selected || pkg.indexedVersions > 0
							const reason =
								selectionBlock(pkg) ??
								(!selected && !pkg.indexedVersions
									? 'No checked releases are available from this market.'
									: undefined)
							const label = 'Select ' + pkg.name + ' for installation'
							return (
								<>
									{showChoice && (
										<label className="pm-market-choice" title={reason}>
											<input
												className="pm-package-select"
												type="checkbox"
												checked={selected}
												aria-label={label}
												title={reason ?? label}
												disabled={busy || Boolean(reason)}
												onChange={() =>
													selected
														? onChange(items.filter((item) => item.name !== pkg.name))
														: add(pkg, pkg.latest, null)
												}
											/>
											<span>
												{selected ? 'Selected for installation' : 'Select for installation'}
											</span>
										</label>
									)}
									{surface === 'detail' && items.length > 0 ? (
										<button type="button" className="pm-button pm-link" onClick={viewSelection}>
											View selection ({items.length})
										</button>
									) : null}
								</>
							)
						}}
						releaseAction={(release) => {
							const existing = selectedByName.get(release.name)
							const reason = selectionBlock(release)
							const selected = !reason && existing?.version === release.version
							return (
								<button
									type="button"
									className="pm-button pm-primary"
									title={reason}
									disabled={busy || Boolean(reason) || selected}
									onClick={() => add(release, existing?.latest ?? null, release.version)}
								>
									{selected
										? 'Version selected'
										: existing && !reason
											? 'Use this version'
											: 'Add to selection'}
								</button>
							)
						}}
						packageStatus={(pkg) => (
							<PackageStatus
								pkg={pkg}
								installation={installations.get(pkg.name)}
								usage={usageByName.get(pkg.name)}
								removalPending={pendingRemovals.has(pkg.name)}
								data={data}
							/>
						)}
					/>
				</MarketContext.Provider>
			</div>
		</div>
	)
}

function PackageStatus({
	pkg,
	installation,
	removalPending,
	usage,
	data,
}: Readonly<{
	pkg: MarketPackageSummary
	installation: ManagedPackage | undefined
	removalPending: boolean
	usage: PackageUsage | undefined
	data: MarketplaceData
}>) {
	const fromThisRegistry = Boolean(
		installation?.entryFile && installation.marketRegistry === pkg.registry,
	)
	const differentRegistry = Boolean(
		installation?.entryFile && installation.marketRegistry && !fromThisRegistry,
	)
	let label = 'Not managed'
	if (installation?.entryFile) {
		if (differentRegistry) label = 'Same name installed from another registry'
		else if (fromThisRegistry)
			label = installation.installedVersion
				? `Installed here ${installation.installedVersion}`
				: 'Source published'
		else
			label = installation.installedVersion
				? `Local version ${installation.installedVersion} · source unknown`
				: 'Source published · registry unknown'
	} else if (installation) label = 'Not published'
	else if (removalPending) label = 'Removal pending'
	else if (usage) label = 'Application package · source unknown'
	const newer =
		fromThisRegistry &&
		pkg.indexedVersions > 0 &&
		pkg.latest &&
		versionRelation(installation?.installedVersion ?? null, pkg.latest) === 'newer'
			? pkg.latest
			: null
	return (
		<span className="pm-package-status">
			<span
				className={fromThisRegistry ? 'pm-badge pm-truncate pm-installed' : 'pm-badge pm-truncate'}
				title={differentRegistry ? label + ': ' + installation?.marketRegistry : label}
			>
				{label}
			</span>
			{!differentRegistry &&
			usage?.plugins.some((plugin) => plugin.lifecycleState === 'running') ? (
				<span className="pm-badge pm-installed">
					{fromThisRegistry ? 'Running in app' : 'Same name running in app'}
				</span>
			) : null}
			{newer ? (
				<data.Release identity={{ registry: pkg.registry, name: pkg.name, version: newer }}>
					{(read) =>
						read.data?.ok && !read.error ? (
							<span
								className="pm-badge pm-truncate pm-update"
								title={`Newer checked release ${newer}`}
							>
								Newer checked {newer}
							</span>
						) : null
					}
				</data.Release>
			) : null}
		</span>
	)
}
