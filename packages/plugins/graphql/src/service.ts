import { mutation, query, type Resolver, resolver, weave } from '@gqloom/core'
import { ValibotWeaver } from '@gqloom/valibot'
import type { GraphQLSchema } from 'graphql'
import { createYoga, type YogaInitialContext } from 'graphql-yoga'
import * as v from 'valibot'

export type GraphQLResolver = unknown
export type GraphQLMiddleware = unknown

export type FullCtx = YogaInitialContext & ServerCtx
type ServerCtx = {}

export type GraphQLModule = {
	resolvers: readonly GraphQLResolver[]
	middlewares?: readonly GraphQLMiddleware[]
}
export type GraphQLModuleInput = GraphQLModule | GraphQLResolver | readonly GraphQLResolver[]

export type GraphQLPluginConfig = {
	codegen?: {
		enabled?: boolean
	}
	/** Used by codegen (introspection), not by the runtime route. */
	endpoint?: string
	/** Workspace path for codegen output. */
	destination?: string
	react?: boolean
	scalarTypes?: Record<string, string>
}

export const GraphQLFactory = { resolver, query, mutation } as const
export const GraphQLValibot = v

export function normalizeModule(mod: GraphQLModuleInput): GraphQLModule {
	if (Array.isArray(mod)) return { resolvers: mod }
	if (mod && typeof mod === 'object' && 'resolvers' in (mod as any)) {
		const m = mod as GraphQLModule
		return { resolvers: m.resolvers ?? [], middlewares: m.middlewares ?? [] }
	}
	return { resolvers: [mod] }
}

export function weaveSchema(input: {
	modules: Iterable<GraphQLModule>
	globals: Iterable<GraphQLMiddleware>
}): GraphQLSchema {
	const resolvers: Resolver[] = [
		resolver({
			_empty: query(v.string()).resolve(() => 'ok'),
		}),
	]
	const middlewares: unknown[] = []

	for (const mw of input.globals) middlewares.push(mw)
	for (const m of input.modules) {
		if (m.resolvers?.length) resolvers.push(...(m.resolvers as Resolver[]))
		if (m.middlewares?.length) middlewares.push(...m.middlewares)
	}

	// gqloom's weave accepts a mixed list of middlewares/resolvers; keep a stable order.
	return weave(ValibotWeaver, ...(middlewares as any[]), ...resolvers)
}

export function createGraphQLFetch(schema: GraphQLSchema) {
	const yoga = createYoga<ServerCtx>({
		landingPage: false,
		graphqlEndpoint: '/graphql',
		maskedErrors: process.env.NODE_ENV === 'production',
		graphiql: process.env.NODE_ENV !== 'production',
		schema,
		fetchAPI: {
			Response: globalThis.Response,
			Request: globalThis.Request,
			Headers: globalThis.Headers,
		},
	})

	return (req: Request, ctx: ServerCtx) => yoga.fetch(req, ctx)
}
