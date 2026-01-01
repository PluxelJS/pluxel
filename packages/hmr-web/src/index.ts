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

export type { UI } from './protocol'
export type {
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
} from './protocol'

export {
	createHmrWebClient,
	getHmrWebClient,
	disposeHmrWebClient,
	type HmrWebClient,
	type HmrWebClientOptions,
} from './web'

export {
	createAuthAwareFetch,
	defaultOnAuthBlocked,
	installGlobalAuthFetch,
	type AuthAwareFetchOptions,
	type AuthBlockedInfo,
	type OnAuthBlocked,
} from './auth'

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
