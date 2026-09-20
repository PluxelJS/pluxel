import type { RootContext, Context } from '@pluxel/core'
import {
	defineContextCapability,
	resolveContextCapability,
	installOwnerViewCapability,
	installRootCapability,
	type ContextCapability,
} from '@pluxel/core/host'
import { defineHostService } from '@pluxel/host'
import { AdminAccessService } from './services/admin-access/AdminAccessService'
import { ManagementAccessService } from './services/admin-access/ManagementAccessService'

export const ManagementAccess: ContextCapability<ManagementAccessService> = defineContextCapability(
	'management.access',
	{ access: 'all', property: 'managementAccess' },
)
export const AdminAccess: ContextCapability<AdminAccessService, 'root'> = defineContextCapability(
	'management.authentication',
	{ access: 'root', property: 'adminAccess' },
)
export type * from './services/admin-access/types'
export type {
	AdminAuthenticationSession,
	AdminAccessAdmission,
} from './services/admin-access/AdminAccessService'

/** Installs authentication authority and owner-bound provider registration, without opening an endpoint. */
export function managementAccess() {
	return defineHostService({
		name: 'ManagementAccess',
		capabilities: [
			installRootCapability(AdminAccess, {
				property: 'adminAccess',
				create: (ctx) => new AdminAccessService(ctx as RootContext),
			}),
			installOwnerViewCapability(ManagementAccess, {
				property: 'managementAccess',
				createRoot: (ctx) =>
					new ManagementAccessService(
						ctx as RootContext,
						resolveContextCapability(ctx, AdminAccess),
					),
				createView: (root, owner) =>
					new ManagementAccessService(
						owner as Context,
						resolveContextCapability(root.ctx.root, AdminAccess),
					),
			}),
		],
	})
}

declare module '@pluxel/core' {
	interface ContextServices {
		readonly managementAccess: ManagementAccessService
	}
	interface RootContextServices {
		readonly adminAccess: AdminAccessService
	}
}
