import { managerResources, managerScope } from './manager.scope.ts'
import { createWorkbenchMarketplaceData } from './workbench-market-data.tsx'
import { PackageManagerPage } from './package-manager-page.tsx'

const marketData = createWorkbenchMarketplaceData(managerResources)

export function Manager() {
	const { host } = managerScope.useWorkbench()
	const snapshotQuery = managerResources.packageManagerSnapshotQuery.useQuery()
	const usageQuery = managerResources.packageUsageQuery.useQuery()
	const preparation = managerResources.prepareInstallMutation.useMutation()
	const confirmation = managerResources.confirmInstallMutation.useMutation()
	const removal = managerResources.removePackagesMutation.useMutation()
	return (
		<PackageManagerPage
			host={host}
			snapshotQuery={snapshotQuery}
			usageQuery={usageQuery}
			preparation={preparation}
			confirmation={confirmation}
			removal={removal}
			marketData={marketData}
			title="Plugin packages"
			initialTab="installed"
		/>
	)
}

export default managerScope.render(Manager)
