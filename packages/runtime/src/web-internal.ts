/**
 * @internal Official React View-host transport.
 *
 * Level 1 management hosts use `@pluxel/runtime/web`; this entry remains private to the
 * official Workbench until the Level 2 renderer/session protocol is finalized.
 */
export {
	createRuntimeTransportClient,
	type RuntimeTransportClient,
	type RuntimeTransportClientOptions,
} from './web/transport-client'
export {
	RuntimeTransportClientProvider,
	type RuntimeTransportClientProviderProps,
	useRuntimeTransportClient,
} from './web/transport-react'
// The official App uses this stable server-owned route to avoid redirecting the security flow
// through the admin-access gate. Other endpoint details remain transport implementation details.
export { RUNTIME_SECURITY_BASE } from './web/paths'
