import type { DocumentReader } from './package-document-explorer.tsx'
import { createContext, useContext, type ComponentProps } from 'react'
import type { createPackageManagerResources } from './package-manager.resources.ts'
import type { MarketplaceData } from './marketplace.tsx'

type MarketQueries = Pick<
	ReturnType<typeof createPackageManagerResources>,
	| 'marketPackagesQuery'
	| 'marketFacetsQuery'
	| 'marketPackageQuery'
	| 'marketReleasesQuery'
	| 'marketReleaseQuery'
>
export const MarketContext = createContext<string | null>(null)
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
	function Facets({ filters, children }: ComponentProps<MarketplaceData['Facets']>) {
		const marketId = useMarketId()
		return children(queries.marketFacetsQuery.useQuery({ marketId, filters }))
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
	return { Packages, Facets, Package, Releases, Release }
}

export function createLocalDocumentReaders({
	localPackageQuery,
}: Pick<ReturnType<typeof createPackageManagerResources>, 'localPackageQuery'>) {
	function bind(source: 'application' | 'managed') {
		function LocalReader({ path, children }: ComponentProps<DocumentReader>) {
			const result = localPackageQuery.useQuery({ source, path: path.map((step) => step.name) })
			return children(result)
		}
		return LocalReader
	}
	return { managed: bind('managed'), application: bind('application') }
}
