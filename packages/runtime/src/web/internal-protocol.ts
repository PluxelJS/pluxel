/** @internal Raw Cap'n Web transport used by the official Workbench adapter. */
import type { RuntimeManagementRpcApi } from './management-rpc-protocol'

export type { RuntimeManagementRpcApi } from './management-rpc-protocol'

export type WorkbenchRpcView = Record<string, unknown>

export type RuntimeRpcApi = RuntimeManagementRpcApi & {
	ping: () => string
	workbenchRpc: (grantId: string) => WorkbenchRpcView
}
