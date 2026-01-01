// Type-only import: ensure @pluxel/hmr/services module augmentations are loaded
// whenever users import from `@pluxel/hmr/web`.
import type {} from '../services'
// Type-only import: ensure `@pluxel/hmr-web`'s `@pluxel/plugin-ui` service augmentations are loaded
// so `ctx.services.hmr` is typed for UI bundles.
import type {} from '@pluxel/hmr-web'

// UI module authoring (re-exported as a stable public surface)
export { ExtensionPoints, definePluginUIModule } from '@pluxel/plugin-ui'
export type {
	AnyExtensionDef,
	ExtensionContext,
	ExtensionDef,
	ExtensionPoint,
	GlobalExtensionContext,
	PluginExtensionContext,
	PluginUIModule,
} from '@pluxel/plugin-ui'

// React utilities (we are React-first, so keep them in the default entry)
export {
	HmrWebClientProvider,
	useHmrWebClient,
	usePluginSse,
	useSharedSseClient,
	useSseClient,
} from '@pluxel/hmr-web/react'

// Browser client helpers (RPC/SSE)
export { createHmrWebClient as createClient } from '@pluxel/hmr-web'
export type { HmrWebClient as Client, HmrWebClientOptions as ClientOptions } from '@pluxel/hmr-web'

export { createRpcClient, invokeRpc, rpcErrorMessage } from '@pluxel/hmr-web'
export { sse } from '@pluxel/hmr-web'
export type { UI } from '@pluxel/hmr-web'
export type {
	HmrRpcApi,
	PackageSpecInput,
	ResolvedSseEvents,
	SseClientOptions,
	SseClientWithNamespaces,
	SseMessage,
} from '@pluxel/hmr-web'
