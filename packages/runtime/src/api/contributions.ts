import type { Resolver } from '@gqloom/core'
import type { Context } from '@pluxel/core'

export type RuntimeApiResolverFactory = (ctx: Context) => Resolver | Resolver[]
export type RuntimeRpcHandleFactory = (ctx: Context) => unknown

const resolverFactories: RuntimeApiResolverFactory[] = []
const rpcHandleFactories = new Map<string, RuntimeRpcHandleFactory>()

export function registerRuntimeApiResolver(factory: RuntimeApiResolverFactory): void {
	if (!resolverFactories.includes(factory)) resolverFactories.push(factory)
}

export function getRuntimeApiResolvers(ctx: Context): Resolver[] {
	return resolverFactories.flatMap((factory) => {
		const value = factory(ctx)
		return Array.isArray(value) ? value : [value]
	})
}

export function registerRuntimeRpcHandle(name: string, factory: RuntimeRpcHandleFactory): void {
	rpcHandleFactories.set(name, factory)
}

export function createRuntimeRpcHandle<T = unknown>(ctx: Context, name: string): T {
	const factory = rpcHandleFactories.get(name)
	if (!factory) {
		throw new Error(`[pluxel/runtime] RPC handle "${name}" is not registered.`)
	}
	return factory(ctx) as T
}
