import { marketplaceResources, marketplaceScope } from './marketplace.scope.ts'
import {
	createWorkbenchMarketplaceData,
	createLocalDocumentReaders,
} from './workbench-market-data.tsx'
import { createRegistryDiscovery } from './registry-discovery.tsx'
import { PackageManagerPage } from './package-manager-page.tsx'

const RegistryDiscovery = createRegistryDiscovery(marketplaceResources.registry)
const localReaders = createLocalDocumentReaders(marketplaceResources)
const marketData = createWorkbenchMarketplaceData(marketplaceResources)

export function MarketplacePage() {
	const { host } = marketplaceScope.useWorkbench()
	const state = marketplaceResources.usePackageManager()
	return (
		<PackageManagerPage
			host={host}
			state={state}
			RegistryDiscovery={RegistryDiscovery}
			marketData={marketData}
			localReaders={localReaders}
			title="Plugin marketplace"
			initialTab="market"
		/>
	)
}

export default marketplaceScope.render(MarketplacePage)
