import type { Resolver } from '@gqloom/core'
import type { Context } from '@pluxel/core'
import type { RuntimeApiResolverFactory, RuntimeRpcHandleFactory } from '../runtime/capabilities'

export type { RuntimeApiResolverFactory, RuntimeRpcHandleFactory }

export function getRuntimeApiResolvers(ctx: Context): Resolver[] {
	return (ctx.runtimeRoute?.api?.resolvers ?? []).flatMap((factory) => {
		const value = factory(ctx)
		return Array.isArray(value) ? value : [value]
	})
}

export function createRuntimeRpcHandle<T = unknown>(ctx: Context, name: string): T {
	const factory = ctx.runtimeRoute?.api?.rpcHandles?.[name]
	if (!factory) {
		throw new Error(`[pluxel/runtime] RPC handle "${name}" is not available on this route.`)
	}
	return factory(ctx) as T
}
