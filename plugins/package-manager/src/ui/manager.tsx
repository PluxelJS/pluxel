import { managerResources, managerScope } from './manager.scope.ts'
import {
	createWorkbenchMarketplaceData,
	createLocalDocumentReaders,
} from './workbench-market-data.tsx'
import { createRegistryDiscovery } from './registry-discovery.tsx'
import { PackageManagerPage } from './package-manager-page.tsx'

const RegistryDiscovery = createRegistryDiscovery(managerResources.registry)
const localReaders = createLocalDocumentReaders(managerResources)
const marketData = createWorkbenchMarketplaceData(managerResources)

export function Manager() {
	const { host } = managerScope.useWorkbench()
	const state = managerResources.usePackageManager()
	return (
		<PackageManagerPage
			host={host}
			state={state}
			RegistryDiscovery={RegistryDiscovery}
			marketData={marketData}
			localReaders={localReaders}
			title="Plugin packages"
			initialTab="installed"
		/>
	)
}

export default managerScope.render(Manager)
