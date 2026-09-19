import '@pluxel/services/vault'

export { createLocalRpcClient } from './testing/local-rpc'
export { createServiceTestHost } from './testing/service-host'
export type {
	OpenedWorkbenchTestEntry,
	OpenedWorkbenchTestLease,
	ServiceCommandsTestDriver,
	ServiceConfigTestDriver,
	ServiceHttpTestDriver,
	ServiceWorkbenchTestDriver,
	WorkbenchTestOpenableEntry,
	WorkbenchTestOpenOptions,
} from './testing/contracts'
export type {
	ServicePluginBatchStartOptions,
	ServicePluginStartOptions,
	ServicePluginTestChange,
	ServiceTestHost,
	ServiceTestHostOptions,
} from './testing/service-host'
