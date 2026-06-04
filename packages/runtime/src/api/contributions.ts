import type { Resolver } from '@gqloom/core'
import type { Context } from '@pluxel/core'
import type { McpServer } from 'mcp-lite'

export type RuntimeApiResolverFactory = (ctx: Context) => Resolver | Resolver[]
export type RuntimeRpcHandleFactory = (ctx: Context) => unknown
export type RuntimeMcpToolRegistrar = (server: McpServer, ctx: Context) => void

const resolverFactories: RuntimeApiResolverFactory[] = []
const rpcHandleFactories = new Map<string, RuntimeRpcHandleFactory>()
const mcpToolRegistrars: RuntimeMcpToolRegistrar[] = []

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

export function registerRuntimeMcpTools(registrar: RuntimeMcpToolRegistrar): void {
	if (!mcpToolRegistrars.includes(registrar)) mcpToolRegistrars.push(registrar)
}

export function applyRuntimeMcpToolContributions(server: McpServer, ctx: Context): void {
	for (const registrar of mcpToolRegistrars) registrar(server, ctx)
}
