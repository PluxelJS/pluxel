import type { RpcStub } from 'capnweb'
import { newHttpBatchRpcSession } from 'capnweb'
import type { HmrRpcApi, RpcExtensions } from './protocol'

export type HmrRpcStub = RpcStub<HmrRpcApi>

export function createRpcClient(rpcBase = '/api/rpc'): HmrRpcStub {
	return newHttpBatchRpcSession<HmrRpcApi>(rpcBase)
}

export function createRpcClientFactory(rpcBase = '/api/rpc'): () => HmrRpcStub {
	// Capnweb batch RPC sessions must be short-lived per call; reusing a closed
	// session will surface "Batch RPC request ended." errors in consumers.
	return () => createRpcClient(rpcBase)
}

export async function invokeRpc<T>(
	runner: (client: HmrRpcStub) => Promise<T>,
	options?: { rpcBase?: string },
): Promise<T> {
	const base = options?.rpcBase ?? '/api/rpc'
	const client = createRpcClient(base)
	try {
		return await runner(client)
	} catch (error) {
		console.error('[HMR RPC] 调用失败', error)
		throw error
	}
}

export function rpcErrorMessage(error: unknown, fallback = 'RPC 调用失败'): string {
	if (error instanceof Error) return error.message || fallback
	if (typeof error === 'string') return error
	return fallback
}

export function createRpcExtensionsView(raw: () => HmrRpcStub): RpcExtensions {
	// Important: capnweb http-batch sessions are short-lived. If we return the raw
	// stub object and users memoize it (e.g. `const rpc = hmr.rpc.MyPlugin`),
	// the session may already be ended when the next interaction happens.
	//
	// To make this ergonomic and safe, we return a stable proxy where each method
	// call creates a fresh session.
	const dispose = (client: HmrRpcStub) => {
		const disposer =
			(client as any)[Symbol.dispose] ??
			(client as any)[Symbol.asyncDispose] ??
			(client as any).dispose
		if (typeof disposer === 'function') {
			try {
				disposer.call(client)
			} catch {}
		}
	}
	return new Proxy(
		{},
		{
			get(_target, namespace) {
				if (typeof namespace !== 'string') return undefined
				return new Proxy(
					{},
					{
						get(_nsTarget, method) {
							if (typeof method !== 'string') return undefined
							return (...args: any[]) => {
								const client = raw()
								const result = (client.ext as any)?.[namespace]?.[method]?.(...args)
								if (result && typeof result.then === 'function') {
									return result.finally(() => dispose(client))
								}
								dispose(client)
								return result
							}
						},
					},
				)
			},
		},
	) as RpcExtensions
}
