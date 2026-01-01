import type { RpcStub } from 'capnweb'
import { newHttpBatchRpcSession } from 'capnweb'
import type { HmrRpcApi, UI } from './protocol'

export type HmrRpcStub = RpcStub<HmrRpcApi>

export type RpcClientCreateOptions = {
	signal?: AbortSignal
	/** Ensure cookies are sent (browser); defaults to `same-origin`. */
	credentials?: RequestCredentials
}

export function createRpcClient(rpcBase = '/api/rpc', options: RpcClientCreateOptions = {}): HmrRpcStub {
	const signal = options.signal
	// When passing a Request, capnweb will reuse its signal/headers/credentials.
	// It still overrides method/body in its internal fetch() call.
	const urlOrRequest =
		signal
			? new Request(rpcBase, {
					signal,
					credentials: options.credentials ?? 'same-origin',
					headers: {
						// Helps servers/proxies treat this as a non-JSON RPC payload.
						'Content-Type': 'text/plain; charset=utf-8',
					},
				})
			: rpcBase
	return newHttpBatchRpcSession<HmrRpcApi>(urlOrRequest as any)
}

export type RpcClientFactory = (options?: RpcClientCreateOptions) => HmrRpcStub

export function createRpcClientFactory(rpcBase = '/api/rpc'): RpcClientFactory {
	// Capnweb batch RPC sessions must be short-lived per call; reusing a closed
	// session will surface "Batch RPC request ended." errors in consumers.
	return (options) => createRpcClient(rpcBase, options)
}

function disposeRpcClient(client: HmrRpcStub) {
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

const DEFAULT_RPC_TIMEOUT_MS = 20_000

function createTimeout(timeoutMs: number) {
	if (timeoutMs <= 0) return { signal: undefined as AbortSignal | undefined, clear: () => {} }
	if (typeof AbortController === 'undefined') return { signal: undefined as AbortSignal | undefined, clear: () => {} }

	const ctrl = new AbortController()
	const timer = setTimeout(() => {
		try {
			ctrl.abort(new Error(`[HMR RPC] timeout after ${timeoutMs}ms`))
		} catch {
			try {
				ctrl.abort()
			} catch {}
		}
	}, timeoutMs)

	return {
		signal: ctrl.signal,
		clear: () => clearTimeout(timer),
	}
}

export async function invokeRpc<T>(
	runner: (client: HmrRpcStub) => Promise<T>,
	options?: { rpcBase?: string; timeoutMs?: number },
): Promise<T> {
	const base = options?.rpcBase ?? '/api/rpc'
	const { signal, clear } = createTimeout(options?.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS)
	const client = createRpcClient(base, { signal })
	try {
		return await runner(client)
	} catch (error) {
		console.error('[HMR RPC] 调用失败', error)
		throw error
	} finally {
		clear()
		disposeRpcClient(client)
	}
}

export function rpcErrorMessage(error: unknown, fallback = 'RPC 调用失败'): string {
	if (error instanceof Error) return error.message || fallback
	if (typeof error === 'string') return error
	return fallback
}

export function createRpcExtensionsView(raw: RpcClientFactory): UI.rpc {
	// Important: capnweb http-batch sessions are short-lived. If we return the raw
	// stub object and users memoize it (e.g. `const rpc = hmr.rpc.MyPlugin`),
	// the session may already be ended when the next interaction happens.
	//
	// To make this ergonomic and safe, we return a stable proxy where each method
	// call creates a fresh session.
	const namespaceCache = new Map<string, unknown>()

	const getNamespaceProxy = (namespace: string) => {
		const existing = namespaceCache.get(namespace)
		if (existing) return existing

		const methodCache = new Map<string, unknown>()
		const nsProxy = new Proxy(
			{},
			{
				get(_nsTarget, method) {
					if (typeof method !== 'string') return undefined

					const cached = methodCache.get(method)
					if (cached) return cached

					const fn = (...args: any[]) => {
						const { signal, clear } = createTimeout(DEFAULT_RPC_TIMEOUT_MS)
						const client = raw({ signal })
						// IMPORTANT: preserve `this` binding for capnweb stubs.
						// Optional-chaining call like `obj?.[method]?.()` can lose the receiver,
						// which may break capnweb's dynamic dispatch.
						const nsTarget = (client.ext as any)?.[namespace]
						const targetFn = nsTarget?.[method]
						// Use Reflect.apply() instead of `fn.apply()` because capnweb stubs are
						// Proxy-based and may intercept the "apply" property access.
						let result: unknown
						try {
							result =
								typeof targetFn === 'function'
									? Reflect.apply(targetFn as any, nsTarget, args)
									: undefined
						} catch (e) {
							clear()
							disposeRpcClient(client)
							throw e
						}

						if (result && typeof (result as any).then === 'function') {
							// Normalize to a native promise so we can always attach `finally`,
							// even if the returned thenable doesn't implement `.finally()`.
							return Promise.resolve(result).finally(() => {
								clear()
								disposeRpcClient(client)
							})
						}
						clear()
						disposeRpcClient(client)
						return result
					}

					methodCache.set(method, fn)
					return fn
				},
			},
		)

		namespaceCache.set(namespace, nsProxy)
		return nsProxy
	}

	return new Proxy(
		{},
		{
			get(_target, namespace) {
				if (typeof namespace !== 'string') return undefined
				return getNamespaceProxy(namespace)
			},
		},
	) as UI.rpc
}
