import type { Context } from '@pluxel/core'
import { readHostPluginStatusOverview, type PluginRecentUpdateRead } from '@pluxel/host/internal'
export {
	type PluginRecentUpdateRead,
	hostPluginStatusOverviewFromView as runtimePluginStatusOverviewFromView,
	type HostPluginAvailability as RuntimePluginAvailability,
	type HostPluginReconciliationCode as RuntimePluginReconciliationCode,
	type HostPluginStatusIssue as RuntimePluginStatusIssue,
	type HostPluginCatalogEntry as RuntimePluginCatalogEntry,
	type HostPluginStatusSnapshot as RuntimePluginStatusSnapshot,
	type HostPluginStatusOverview as RuntimePluginStatusOverview,
	type HostPluginStatusProjectionView as RuntimePluginStatusProjectionView,
} from '@pluxel/host/internal'
export interface RuntimeModuleCacheEntry {
	id: string
	exports: Record<string, unknown>
	aliases?: readonly string[]
}

export interface RuntimeModuleRuntime {
	normalizeId(moduleId: string): string
	moduleIdAliases(moduleId: string): Iterable<string>
	primeModuleCacheEntry(entry: RuntimeModuleCacheEntry): void
	dropModuleCacheEntries(ids: Iterable<string>): void
}

export type RuntimeRouteCapabilities = {
	recentUpdate?: PluginRecentUpdateRead
	modules?: RuntimeModuleRuntime
	dynamicPluginSources?: {
		hasFile(path: string): boolean
		hasDirectory(path: string, include: readonly string[]): boolean
	}
}

const identityModuleRuntime: RuntimeModuleRuntime = {
	normalizeId: (moduleId) => moduleId,
	moduleIdAliases: (moduleId) => [moduleId],
	primeModuleCacheEntry() {},
	dropModuleCacheEntries() {},
}

type RuntimeRouteInstallation = {
	readonly capabilities: RuntimeRouteCapabilities
	readonly previous: RuntimeRouteInstallation | undefined
	active: boolean
}

const routeCapabilities = new WeakMap<Context['root'], RuntimeRouteInstallation>()

/** @internal Installs one immutable host-owned route capability snapshot. */
export function installRuntimeRouteCapabilities(
	ctx: Context,
	capabilities: RuntimeRouteCapabilities,
): () => void {
	const root = ctx.root
	const installed: RuntimeRouteInstallation = {
		capabilities: Object.freeze({ ...capabilities }),
		previous: routeCapabilities.get(root),
		active: true,
	}
	routeCapabilities.set(root, installed)
	return (): void => {
		if (!installed.active) return
		installed.active = false
		if (routeCapabilities.get(root) !== installed) return
		let previous = installed.previous
		while (previous && !previous.active) previous = previous.previous
		if (previous) routeCapabilities.set(root, previous)
		else routeCapabilities.delete(root)
	}
}

/** @internal Read-only projection for runtime host integration. */
export function readRuntimeRouteCapabilities(ctx: Context): RuntimeRouteCapabilities | undefined {
	return routeCapabilities.get(ctx.root)?.capabilities
}

export function requireRouteCapability<K extends keyof RuntimeRouteCapabilities>(
	ctx: Context,
	key: K,
): NonNullable<RuntimeRouteCapabilities[K]> {
	const value = readRuntimeRouteCapabilities(ctx)?.[key]
	if (!value) {
		throw new Error(`[pluxel/runtime] Runtime route capability "${key}" is not available.`)
	}
	return value
}

export function runtimeModuleRuntime(ctx: Context): RuntimeModuleRuntime {
	return readRuntimeRouteCapabilities(ctx)?.modules ?? identityModuleRuntime
}

export function readRuntimePluginStatusOverview(ctx: Context) {
	return readHostPluginStatusOverview(ctx, readRuntimeRouteCapabilities(ctx)?.recentUpdate)
}
