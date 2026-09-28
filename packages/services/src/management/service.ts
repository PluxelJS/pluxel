import type { Context, RootContext } from '@pluxel/core'
import { installRootCapability, installOwnerViewCapability } from '@pluxel/core/host'
import { defineHostService } from '@pluxel/host'
import { Persistence } from '../persistence'
import { AdminAccess } from './access'
import { Management, CatalogLayout, ApiValidation } from './token'
import { RuntimeManagementService } from './services/RuntimeManagementService'
import { PluginCatalogLayoutService } from './services/management/PluginCatalogLayoutService'
import { InternalApiValidationService } from './services/http/InternalApiValidationService'
import { bindManagementHostOptions, type ManagementHostOptions } from './host-options'
import { RuntimeManagementTargetImpl } from './services/management/RuntimeManagementTarget'
import { readProductDescriptor, type HostApplicationMeta } from './product-contract'

export { Management } from './token'
export type ManagementServiceOptions = ManagementHostOptions &
	Readonly<{
		application?: HostApplicationMeta
		workbench?: boolean
	}>

/** Installs the shared Host management projection. Authentication and persistence are explicit prerequisites. */
export function management(options: ManagementServiceOptions = {}) {
	const application = Object.freeze({
		product: options.application?.product
			? readProductDescriptor(options.application.product, 'management.application.product')
			: null,
	})
	const workbench = options.workbench === true
	const inputs = Object.freeze({ recentUpdate: options.recentUpdate })
	return defineHostService({
		name: 'Management',
		requires: { authentication: AdminAccess, persistence: Persistence },
		capabilities: [
			installRootCapability(Management, {
				property: 'runtimeManagement',
				create: (ctx) => new RuntimeManagementService(ctx, application, workbench),
			}),
			installRootCapability(CatalogLayout, {
				property: 'pluginCatalogLayout',
				create: (ctx) => new PluginCatalogLayoutService(ctx),
			}),
			installOwnerViewCapability(ApiValidation, {
				property: 'internalApiValidation',
				createRoot: (ctx) => new InternalApiValidationService(ctx as Context),
				createView: (root, owner) => root.forOwner(owner),
			}),
		],
		prepare: ({ ctx, effects }) => {
			effects.defer(bindManagementHostOptions(ctx, inputs), {
				tag: 'ManagementInputs',
				phase: 'shutdown',
			})
		},
	})
}

/** Host-only adapter for an authenticated endpoint; the target reuses the installed Host coordinator. */
export function createHostManagementTarget(
	ctx: RootContext,
	session?: Readonly<{ signal: AbortSignal }>,
): RuntimeManagementTargetImpl {
	if (ctx !== ctx.root) throw new TypeError('Management target requires a Host root Context')
	return new RuntimeManagementTargetImpl(ctx, session?.signal)
}
