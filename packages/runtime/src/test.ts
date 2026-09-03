import './index'
import './services/vault'

export { createLocalRpcClient } from './testing/local-rpc'
export { createRuntimeTestHost } from './testing/runtime-host'
export type {
	OpenedWorkbenchTestEntry,
	OpenedWorkbenchTestLease,
	RuntimeCommandsTestDriver,
	RuntimeConfigTestDriver,
	RuntimeHttpTestDriver,
	RuntimeStaticPluginTestTarget,
	RuntimeWorkbenchTestDriver,
	WorkbenchTestOpenableEntry,
	WorkbenchTestOpenOptions,
} from './testing/contracts'
export type {
	RuntimePluginBatchStartOptions,
	RuntimePluginStartOptions,
	RuntimePluginTestChange,
	RuntimeTestHost,
	RuntimeTestHostConfig,
} from './testing/runtime-host'

export {
	BasePlugin,
	definePluginFork,
	Plugin,
	PluginLifecycleAssertionError,
	PluginPart,
} from '@pluxel/core/test'
export type {
	DependencyOverrideInput,
	DependencyOverrideTarget,
	LifecycleFailureCommitSummary,
	PluginConstructor,
	PluginDefinitionAddress,
	PluginForkRef,
	PluginInitialConfigOptions,
	PluginInstanceFor,
	PluginInstances,
	PluginLifecycleAssertionOperation,
	PluginLifecycleErrorInfo,
	PluginLifecycleIssueKind,
	PluginLifecycleIssuePhase,
	PluginNodeAddress,
	PluginRef,
	PluginTestCommitSummary,
	PluginTestLifecycleIssue,
	PluginTestTarget,
	PluginToken,
	ProviderDefaultInput,
	RawPluginConfig,
} from '@pluxel/core/test'
