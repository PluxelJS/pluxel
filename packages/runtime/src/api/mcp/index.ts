import type { Context } from '@pluxel/core'
import { toJsonSchema } from '@valibot/to-json-schema'
import { InMemorySessionAdapter, McpServer, StreamableHttpTransport } from 'mcp-lite'
import { applyRuntimeMcpToolContributions } from '../contributions'
import { registerRuntimeDevTools } from './dev-tools'
import { registerRuntimeOpsCarrier } from './ops-carrier'
import { isJsonSchemaObject } from './shared'

type CachedHandlerEntry = {
	opsVersion: number
	sessionAdapter: InMemorySessionAdapter
	current: (req: Request) => Promise<Response>
	stable: (req: Request) => Promise<Response>
}

const handlerCache = new WeakMap<Context, CachedHandlerEntry>()

function resolveRootContext(ctx: Context): Context {
	return (ctx.root ?? ctx) as Context
}

function createPluxelMcpServer(ctx: Context) {
	const server = new McpServer({
		name: 'pluxel-hmr',
		version: 'dev',
		schemaAdapter: (schema) =>
			(isJsonSchemaObject(schema)
				? (schema as Record<string, unknown>)
				: (toJsonSchema(schema as any) as Record<string, unknown>)),
	})

	registerRuntimeOpsCarrier(server, ctx)
	registerRuntimeDevTools(server, ctx)
	applyRuntimeMcpToolContributions(server, ctx)
	return server
}

export function getHmrMcpHttpHandler(ctx: Context): (req: Request) => Promise<Response> {
	const root = resolveRootContext(ctx)
	let cached = handlerCache.get(root)
	if (!cached) {
		cached = {
			opsVersion: -1,
			sessionAdapter: new InMemorySessionAdapter({ maxEventBufferSize: 1024 }),
			current: async () => new Response('MCP handler not initialized', { status: 500 }),
			stable: async (req: Request) => {
				const active = ensureCachedHandler(root)
				return await active.current(req)
			},
		}
		handlerCache.set(root, cached)
	}

	return ensureCachedHandler(root).stable
}

function ensureCachedHandler(root: Context): CachedHandlerEntry {
	const cached = handlerCache.get(root)
	if (!cached) throw new Error('MCP handler cache entry missing')
	if (cached.opsVersion === root.ops.version) return cached

	const server = createPluxelMcpServer(root)
	const transport = new StreamableHttpTransport({
		sessionAdapter: cached.sessionAdapter,
	})
	const handler = transport.bind(server)
	cached.current = async (req: Request) => await handler(req)
	cached.opsVersion = root.ops.version
	return cached
}
