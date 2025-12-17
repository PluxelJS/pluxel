// @pluxel/hmr/test
//
// Test helpers for the HMR runtime that build on top of `@pluxel/core/test`.
// Goal: make it easy to test services like HonoService/RpcService without opening ports:
// - use `honoService.fetch(new Request(...))` directly (pure request/response);
// - keep setup explicit and stable.

import '@pluxel/core/test/setup'
import '../services'

import { newHttpBatchRpcResponse } from 'capnweb'
import type { RpcTarget } from 'capnweb'

export {
	Context,
	BasePlugin,
	ForkablePlugin,
	Config,
	Plugin,
	checkPluginDecorator,
	clearParamToken,
	getPluginInfo,
	setParamToken,
	setParamTokens,
	EffectScopeService,
	EventsService,
	LoggerService,
	createTestContext,
	createTestHost,
	createPluginTestHost,
	withTestContext,
	withTestHost,
	withPluginTestHost,
} from '@pluxel/core/test'

/**
 * Convenience helper for HonoService: issue a request through the in-memory fetch handler.
 * This never binds a port; it only executes the Hono routing pipeline.
 */
export async function honoFetch(
	ctx: { honoService: { fetch: (req: Request) => Response | Promise<Response> } },
	input: string | URL | Request,
	init?: RequestInit,
): Promise<Response> {
	const req =
		input instanceof Request
			? input
			: new Request(input, {
					...init,
					headers: new Headers(init?.headers),
				})
	return await ctx.honoService.fetch(req)
}

/**
 * Create a Capnweb HTTP-batch RPC client that talks to a local `RpcTarget` without opening a port.
 *
 * How it works:
 * - Capnweb's `newHttpBatchRpcSession()` uses global `fetch()` internally.
 * - We temporarily patch `globalThis.fetch` to route requests to `newHttpBatchRpcResponse()`.
 *
 * Caveat:
 * - This patches global state, so do not run this helper in parallel tests.
 */
export async function withInMemoryCapnwebRpcClient<T>(
	localMain: RpcTarget,
	fn: (remoteMain: any) => Promise<T> | T,
): Promise<T> {
	const originalFetch = globalThis.fetch
	globalThis.fetch = (async (input: any, init?: any) => {
		const req =
			input instanceof Request ? input : new Request(String(input), init as RequestInit | undefined)
		return await newHttpBatchRpcResponse(req, localMain)
	}) as any

	try {
		// capnweb's type surface is intentionally very expressive; cast to avoid
		// "type instantiation is excessively deep" errors in TS language services.
		const capnwebAny: any = await import('capnweb')
		const remote = capnwebAny.newHttpBatchRpcSession('http://local/rpc')
		return await fn(remote)
	} finally {
		globalThis.fetch = originalFetch
	}
}
