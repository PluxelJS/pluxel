import { marketplaceResources, marketplaceScope } from './marketplace.scope.ts'
import { createWorkbenchMarketplaceData } from './workbench-market-data.tsx'
import { PackageManagerPage } from './package-manager-page.tsx'

const marketData = createWorkbenchMarketplaceData(marketplaceResources)

export function MarketplacePage() {
	const { host } = marketplaceScope.useWorkbench()
	const snapshotQuery = marketplaceResources.packageManagerSnapshotQuery.useQuery()
	const usageQuery = marketplaceResources.packageUsageQuery.useQuery()
	const preparation = marketplaceResources.prepareInstallMutation.useMutation()
	const confirmation = marketplaceResources.confirmInstallMutation.useMutation()
	const removal = marketplaceResources.removePackagesMutation.useMutation()
	return (
		<PackageManagerPage
			host={host}
			snapshotQuery={snapshotQuery}
			usageQuery={usageQuery}
			preparation={preparation}
			confirmation={confirmation}
			removal={removal}
			marketData={marketData}
			title="Plugin marketplace"
			initialTab="market"
		/>
	)
}

export default marketplaceScope.render(MarketplacePage)
