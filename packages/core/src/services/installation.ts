import {
	installRootService as installKernelRootService,
	installScopeService as installKernelScopeService,
	installOwnerViewService as installKernelOwnerViewService,
	type ServiceDefinition,
	type ServiceAccess,
	type RootServiceInstallation,
	type ScopeServiceInstallation,
	type OwnerViewServiceInstallation,
} from '@pluxel/context'
import type { Context, RootContext } from '../context/Context'

// These factories execute only in a Core Context; the fixed-plan implementation belongs to the kernel.
export const installRootService = installKernelRootService as <T>(
	definition: ServiceDefinition<T, ServiceAccess>,
	options: { readonly access?: 'all' | 'root'; create(ctx: RootContext): NoInfer<T> },
) => RootServiceInstallation<T>
export const installScopeService = installKernelScopeService as <
	T,
	A extends ServiceAccess = ServiceAccess,
>(
	definition: ServiceDefinition<T, A>,
	options: { readonly access?: A; create(ctx: Context): NoInfer<T> },
) => ScopeServiceInstallation<T, A>
export const installOwnerViewService = installKernelOwnerViewService as <
	B,
	T,
	A extends ServiceAccess = ServiceAccess,
>(
	definition: ServiceDefinition<T, A>,
	options: {
		readonly access?: A
		createRoot(ctx: RootContext): B
		createView(backing: B, owner: Context): NoInfer<T>
	},
) => OwnerViewServiceInstallation<B, T, A>
