import type { Resolver } from '@gqloom/core'
import type { Context } from '@pluxel/core'
import type { RuntimeApiResolverFactory, RuntimeRouteCapabilities } from '../runtime/capabilities'

export type { RuntimeApiResolverFactory }

function runtimeRoute(ctx: Context): RuntimeRouteCapabilities | undefined {
	return ctx.runtimeRoute ?? ctx.root.runtimeRoute
}

export function getRuntimeApiResolvers(ctx: Context): Resolver[] {
	return (runtimeRoute(ctx)?.api?.resolvers ?? []).flatMap((factory) => {
		const value = factory(ctx)
		return Array.isArray(value) ? value : [value]
	})
}

export function listRuntimeRouteFeatures(ctx: Context): string[] {
	return Object.keys(runtimeRoute(ctx)?.features ?? {}).sort()
}

export function createRuntimeRouteFeatureHandle<T = unknown>(ctx: Context, name: string): T {
	const factory = runtimeRoute(ctx)?.features?.[name]
	if (!factory) {
		throw new Error(`[pluxel/runtime] route feature "${name}" is not available on this route.`)
	}
	return factory(ctx) as T
}
