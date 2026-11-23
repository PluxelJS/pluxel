import { managerResources, managerScope } from './manager.scope.ts'
import { createWorkbenchMarketplaceData } from './workbench-market-data.tsx'
import { PackageManagerPage } from './package-manager-page.tsx'

const marketData = createWorkbenchMarketplaceData(managerResources)

export function Manager() {
	const { host } = managerScope.useWorkbench()
	const state = managerResources.usePackageManager()
	return (
		<PackageManagerPage
			host={host}
			state={state}
			marketData={marketData}
			title="Plugin packages"
			initialTab="installed"
		/>
	)
}

export default managerScope.render(Manager)
