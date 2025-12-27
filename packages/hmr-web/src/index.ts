export type {
	ExtensionContext,
	GlobalExtensionContext,
	PluginExtensionContext,
	ExtensionPoint,
	AnyExtensionDef,
	ExtensionDef,
	PluginUIModule,
} from '@pluxel/plugin-ui'

export { ExtensionPoints, definePluginUIModule } from '@pluxel/plugin-ui'

export type {
	RpcExtensions,
	SseEvents,
	HmrRpcApi,
	PluginStatusAction,
	PluginStatusBatchAction,
	PluginStatusBatchResult,
	PluginStatusMutationResult,
	PluginDependencyKind,
	PluginDependencyOption,
	PluginDependencyState,
	PluginDependencyMutationResult,
	EnsureForkResult,
	BaseProvisionInfo,
	ConfigPatch,
	ConfigResult,
	ConfigResultOk,
	ConfigResultErr,
	SchemaResult,
	SchemaResultOk,
	SchemaResultErr,
	PackageHandleApi,
	PackageSpecInput,
	PackageMutationAction,
	PackageMutationInput,
	PackageMutationOptions,
	PackageMutationResult,
	PackageBatchResult,
	MarketHandleApi,
	MarketMutationAction,
	MarketMutationInput,
	MarketMutationOptions,
	MarketMutationResult,
	MarketBatchResult,
} from './protocol'

export {
	createHmrWebClient,
	hmrWebClient,
	client,
	type HmrWebClient,
	type HmrWebClientOptions,
} from './web'

export {
	sse,
	type ResolvedSseEvents,
	type SseClientOptions,
	type SseClientWithNamespaces,
	type SseMessage,
	type LogRecord,
} from './sse'

export { invokeRpc, rpcErrorMessage } from './rpc'
export { createRpcClient } from './rpc'

// Ensure ctx.services.hmr is typed when @pluxel/hmr-web is in the TS program.
import './plugin-ui-augment'
