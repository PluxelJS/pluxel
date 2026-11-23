import { marketplaceResources, marketplaceScope } from './marketplace.scope.ts'
import { createWorkbenchMarketplaceData } from './workbench-market-data.tsx'
import { PackageManagerPage } from './package-manager-page.tsx'

const marketData = createWorkbenchMarketplaceData(marketplaceResources)

export function MarketplacePage() {
	const { host } = marketplaceScope.useWorkbench()
	const state = marketplaceResources.usePackageManager()
	return (
		<PackageManagerPage
			host={host}
			state={state}
			marketData={marketData}
			title="Plugin marketplace"
			initialTab="market"
		/>
	)
}

export default marketplaceScope.render(MarketplacePage)
