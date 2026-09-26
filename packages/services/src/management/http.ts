import type { RootContext } from '@pluxel/core'
import { defineHostService, type HostService } from '@pluxel/host'
import { ElysiaRuntime } from '../elysia/runtime'
import { AdminAccess } from './access'
import { Management } from './token'
import type { ManagementEndpointOptions } from './index'
import { attachManagementHttp } from './http-internal'

/** Optional Workbench bindings are borrowed from the selected Host's service. */
export type ManagementHttpOptions = Readonly<{
	bindings?(ctx: RootContext): Pick<ManagementEndpointOptions, 'createWorkbench' | 'artifacts'>
	onError?(error: unknown): void
}>

/** Attach shared management to the selected HTTP carrier without owning its listener. */
export function managementHttp(options: ManagementHttpOptions = {}): HostService<readonly []> {
	return defineHostService({
		name: 'ManagementHTTP',
		capabilities: [],
		requires: { http: ElysiaRuntime, management: Management, authentication: AdminAccess },
		prepare: ({ ctx, effects }) => attachManagementHttp(ctx, effects, options),
	})
}
