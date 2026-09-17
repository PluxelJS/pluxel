/** Host and service-author composition; no service factories run during plan compilation. */
export {
	getContextInstallationCapability,
	resolveContextCapability,
	type ContextCapabilityAccess,
	type ContextCapabilityInstallation,
	type ContextHost,
	type ContextOf,
	type RootContextOf,
	type ContextProjection,
	type RootContextProjection,
	type ValidateContextInstallations,
} from '@pluxel/context'
export { createCoreContextHost } from './context/core-plan'
export type { Context, RootContext, CoreHostConfig } from './context/Context'

import {
	defineContextCapability as defineKernelContextCapability,
	installRootCapability as installKernelRootCapability,
	installScopeCapability as installKernelScopeCapability,
	installOwnerViewCapability as installKernelOwnerViewCapability,
	type ContextCapability as KernelContextCapability,
	type ContextCapabilityAccess,
	type RootCapabilityInstallation as KernelRootCapabilityInstallation,
	type ScopeCapabilityInstallation as KernelScopeCapabilityInstallation,
	type OwnerViewCapabilityInstallation as KernelOwnerViewCapabilityInstallation,
} from '@pluxel/context'
import type { Context, RootContext } from './context/Context'

/** A service token uses the Core kernel; the local name is retained in downstream declarations. */
export interface ContextCapability<
	T,
	A extends ContextCapabilityAccess = 'all',
> extends KernelContextCapability<T, A> {}

export const defineContextCapability = defineKernelContextCapability as {
	<T>(
		description: string,
		options: { readonly access: 'root'; readonly property?: PropertyKey },
	): ContextCapability<T, 'root'>
	<T>(
		description: string,
		options: { readonly access: 'owner'; readonly property?: PropertyKey },
	): ContextCapability<T, 'owner'>
	<T>(
		description: string,
		options?: { readonly access: 'all'; readonly property?: PropertyKey },
	): ContextCapability<T>
}

/** Core-owned declaration names keep inferred service exports on the Core kernel identity. */
export interface RootCapabilityInstallation<
	T = any,
	P extends PropertyKey | undefined = undefined,
> extends KernelRootCapabilityInstallation<T, P> {}
export interface ScopeCapabilityInstallation<
	T = any,
	P extends PropertyKey | undefined = undefined,
	A extends ContextCapabilityAccess = ContextCapabilityAccess,
> extends KernelScopeCapabilityInstallation<T, P, A> {}
export interface OwnerViewCapabilityInstallation<
	B = any,
	T = any,
	P extends PropertyKey | undefined = undefined,
	A extends ContextCapabilityAccess = ContextCapabilityAccess,
> extends KernelOwnerViewCapabilityInstallation<B, T, P, A> {}

// Core service factories run only in Core hosts; the backing implementation remains the kernel's.
export const installRootCapability = installKernelRootCapability as {
	<T, const P extends PropertyKey>(
		token: ContextCapability<T, ContextCapabilityAccess>,
		options: { readonly property: P; create(ctx: RootContext): T },
	): RootCapabilityInstallation<T, P>
	<T>(
		token: ContextCapability<T, ContextCapabilityAccess>,
		options: { create(ctx: RootContext): T },
	): RootCapabilityInstallation<T, undefined>
}
export const installScopeCapability = installKernelScopeCapability as {
	<T, const P extends PropertyKey, A extends ContextCapabilityAccess = ContextCapabilityAccess>(
		token: ContextCapability<T, A>,
		options: { readonly property: P; create(ctx: Context): T },
	): ScopeCapabilityInstallation<T, P, A>
	<T, A extends ContextCapabilityAccess = ContextCapabilityAccess>(
		token: ContextCapability<T, A>,
		options: { create(ctx: Context): T },
	): ScopeCapabilityInstallation<T, undefined, A>
}
export const installOwnerViewCapability = installKernelOwnerViewCapability as {
	<B, T, const P extends PropertyKey, A extends ContextCapabilityAccess = ContextCapabilityAccess>(
		token: ContextCapability<T, A>,
		options: {
			readonly property: P
			createRoot(ctx: RootContext): B
			createView(backend: B, owner: Context): T
		},
	): OwnerViewCapabilityInstallation<B, T, P, A>
	<B, T, A extends ContextCapabilityAccess = ContextCapabilityAccess>(
		token: ContextCapability<T, A>,
		options: { createRoot(ctx: RootContext): B; createView(backend: B, owner: Context): T },
	): OwnerViewCapabilityInstallation<B, T, undefined, A>
}

export { enterOwnerInvocation, type OwnerInvocationLease } from './internal/owner-invocations'

export type {
	CorePluginLifecycleHooks,
	CoreGenerationFinalization,
	CoreGenerationSettlement,
	CoreGenerationRejection,
	CoreCommitPublication,
} from './plugins/runtime/plugin-service/HostLifecycle'

export { getContextLoggerRootId } from './logger/LoggerService'
