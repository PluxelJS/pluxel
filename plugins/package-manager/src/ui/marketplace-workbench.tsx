import { createContext, useContext, useId, useState, type ComponentProps } from 'react'
import type { MarketInstallRequest, PackageMarket } from '../contracts.ts'
import { Marketplace, type MarketplaceData } from './marketplace.tsx'
import type { createPackageManagerResources } from './package-manager.resources.ts'
import { marketplaceStyles } from './marketplace.styles.ts'

type MarketQueries = Pick<
	ReturnType<typeof createPackageManagerResources>,
	'marketPackagesQuery' | 'marketPackageQuery' | 'marketReleasesQuery' | 'marketReleaseQuery'
>
const MarketContext = createContext<string | null>(null)
function useMarketId() {
	const marketId = useContext(MarketContext)
	if (marketId === null) throw new Error('Workbench market read is outside its market binding')
	return marketId
}

/** Call at module scope with one descriptor's fixed resource definitions. */
export function createWorkbenchMarketplaceData(queries: MarketQueries): MarketplaceData {
	function Packages({ query, children }: ComponentProps<MarketplaceData['Packages']>) {
		const marketId = useMarketId()
		return children(queries.marketPackagesQuery.useQuery({ marketId, query }))
	}
	function Package({ identity, children }: ComponentProps<MarketplaceData['Package']>) {
		const marketId = useMarketId()
		return children(queries.marketPackageQuery.useQuery({ marketId, ...identity }))
	}
	function Releases({ identity, query, children }: ComponentProps<MarketplaceData['Releases']>) {
		const marketId = useMarketId()
		return children(
			queries.marketReleasesQuery.useQuery({
				marketId,
				name: identity.name,
				query: { ...query, registry: identity.registry },
			}),
		)
	}
	function Release({ identity, children }: ComponentProps<MarketplaceData['Release']>) {
		const marketId = useMarketId()
		return children(queries.marketReleaseQuery.useQuery({ marketId, ...identity }))
	}
	return { Packages, Package, Releases, Release }
}

type WorkbenchMarketplaceProps = Readonly<{
	markets: readonly PackageMarket[]
	data: MarketplaceData
	busy: boolean
	onPrepare(request: MarketInstallRequest): void
	colorScheme: 'light' | 'dark'
}>

/** Workbench transport stays inside its existing per-open resource owner. */
export function WorkbenchMarketplace({
	markets,
	data,
	busy,
	onPrepare,
	colorScheme,
}: WorkbenchMarketplaceProps) {
	const [selectedMarket, setSelectedMarket] = useState<string>()
	const market = markets.find((item) => item.id === selectedMarket) ?? markets[0]
	const id = useId()
	if (!market) return <p>No market is configured for this application.</p>
	return (
		<div className="plx-marketplace" data-color-scheme={colorScheme}>
			<style>{marketplaceStyles}</style>
			<div className="pm-stack">
				{markets.length > 1 ? (
					<div className="pm-field">
						<label htmlFor={id}>Market</label>
						<select
							id={id}
							value={market.id}
							onChange={(event) => setSelectedMarket(event.currentTarget.value)}
						>
							{markets.map((item) => (
								<option key={item.id} value={item.id}>
									{item.id}
								</option>
							))}
						</select>
					</div>
				) : (
					<p className="pm-small pm-muted">
						Market: {market.id} · {market.url}
					</p>
				)}
				<MarketContext.Provider value={market.id}>
					<Marketplace
						key={market.id}
						data={data}
						colorScheme={colorScheme}
						busy={busy}
						onPrepare={(selection) => onPrepare({ marketId: market.id, ...selection })}
					/>
				</MarketContext.Provider>
			</div>
		</div>
	)
}
