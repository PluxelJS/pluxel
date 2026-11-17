import { resolveContextService } from '@pluxel/core/internal'
import type { RootContext, Context } from '@pluxel/core'
import { installOwnerViewService, installRootService } from '@pluxel/core/host'
import { defineHostService, type HostService } from '@pluxel/host'
import { AdminAccessService } from './services/admin-access/AdminAccessService'
import { ManagementAccessService } from './services/admin-access/ManagementAccessService'
export abstract class ManagementAccess {}
export interface ManagementAccess extends ManagementAccessService {}
export abstract class AdminAccess {
	static readonly access = 'root' as const
}
export interface AdminAccess extends AdminAccessService {}
export type * from './services/admin-access/types'
export type {
	AdminAuthenticationSession,
	AdminAccessAdmission,
} from './services/admin-access/AdminAccessService'

/** Installs authentication authority and owner-bound provider registration, without opening an endpoint. */
export function managementAccess(): HostService {
	return defineHostService({
		name: 'ManagementAccess',
		provides: [
			installRootService(AdminAccess, {
				create: (ctx) => new AdminAccessService(ctx as RootContext),
			}),
			installOwnerViewService(ManagementAccess, {
				createRoot: (ctx) =>
					new ManagementAccessService(ctx as RootContext, resolveContextService(ctx, AdminAccess)),
				createView: (root, owner) =>
					new ManagementAccessService(
						owner as Context,
						resolveContextService(root.ctx.root, AdminAccess),
					),
			}),
		],
	})
}
