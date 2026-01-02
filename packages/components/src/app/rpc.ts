// Curated host-side exports (avoid wildcard re-exports).
export {
	createAuthAwareFetch,
	invokeRpc,
	rpcErrorMessage,
} from '@pluxel/hmr-web'
export type {
	PackageBatchResult,
	PackageInventoryEntry,
	PackageInventoryFilter,
	PackageIssueSpec,
	PackageLoadIssue,
	PackageSpecInput,
	PluginGroup,
	PluginGroupInput,
} from '@pluxel/hmr-web'

export { HmrWebClientProvider, useHmrWebClient } from '@pluxel/hmr-web/react'
