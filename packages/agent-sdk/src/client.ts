/** Node client operations. Each call closes its connections; accepted runs belong to the Host. */
export {
	listHosts,
	runScript,
	controlHmr,
	getScriptResult,
	cancelScript,
	syncPluginControl,
} from './client/operations'
export {
	HostClientError,
	type HostCredentials,
	type LocalHostTarget,
	type RemoteHostTarget,
	type HostTarget,
	type HostInstance,
	type HostDiscovery,
	type ScriptRunResult,
	type ScriptRunOptions,
	type HmrControlOptions,
	type ReceiptQueryOptions,
	type ControlSyncOptions,
	type HostClientFailure,
} from './client/contracts'
export type { ControlSyncResult } from './client/materials'
export type { ScriptRunSnapshot } from '@pluxel/host/internal/agent/runtime'
