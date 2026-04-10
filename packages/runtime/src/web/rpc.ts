import { newHttpBatchRpcSession, type RpcStub } from 'capnweb'
import { HMR_INTERNAL_API_BASE } from './paths'
import type { ExtensionUiRpcMap, RuntimeOpDescriptor, RuntimeRpcApi } from './protocol'

export type RuntimeRpcStub = RpcStub<RuntimeRpcApi>

export type RpcClientCreateOptions = {
	signal?: AbortSignal
	/** Ensure cookies are sent (browser); defaults to `same-origin`. */
	credentials?: RequestCredentials
}

export function createRpcClient(
	rpcBase = `${HMR_INTERNAL_API_BASE}/rpc`,
	options: RpcClientCreateOptions = {},
): RuntimeRpcStub {
	const signal = options.signal
	const credentials = options.credentials

	// When passing a Request, capnweb will reuse its signal/headers/credentials.
	// It still overrides method/body in its internal fetch() call.
	const urlOrRequest =
		signal || credentials !== undefined
			? new Request(rpcBase, {
					signal,
					credentials: credentials ?? 'same-origin',
					headers: {
						// Helps servers/proxies treat this as a non-JSON RPC payload.
						'Content-Type': 'text/plain; charset=utf-8',
					},
				})
			: rpcBase
	return newHttpBatchRpcSession<RuntimeRpcApi>(urlOrRequest as any)
}

export type RpcClientFactory = (options?: RpcClientCreateOptions) => RuntimeRpcStub

export function createRpcClientFactory(rpcBase = `${HMR_INTERNAL_API_BASE}/rpc`): RpcClientFactory {
	// Capnweb batch RPC sessions must be short-lived per call; reusing a closed
	// session will surface "Batch RPC request ended." errors in consumers.
	return (options) => createRpcClient(rpcBase, options)
}

function disposeRpcClient(client: RuntimeRpcStub) {
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
	if (typeof AbortController === 'undefined')
		return { signal: undefined as AbortSignal | undefined, clear: () => {} }

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
	runner: (client: RuntimeRpcStub) => Promise<T>,
	options?: { rpcBase?: string; timeoutMs?: number; credentials?: RequestCredentials },
): Promise<T> {
	const base = options?.rpcBase ?? `${HMR_INTERNAL_API_BASE}/rpc`
	const { signal, clear } = createTimeout(options?.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS)
	const client = createRpcClient(base, { signal, credentials: options?.credentials })
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

export async function listRuntimeOps(
	options?: { rpcBase?: string; timeoutMs?: number; credentials?: RequestCredentials },
): Promise<RuntimeOpDescriptor[]> {
	return await invokeRpc((rpc) => Promise.resolve(rpc.opsList()), options)
}

export async function invokeRuntimeOp<T = unknown>(
	id: string,
	input?: unknown,
	options?: { rpcBase?: string; timeoutMs?: number; credentials?: RequestCredentials },
): Promise<T> {
	return await invokeRpc((rpc) => rpc.opsInvoke(id, input) as unknown as Promise<T>, options)
}

export async function dispatchRuntimeCommand<T = unknown>(
	command: string,
	options?: { rpcBase?: string; timeoutMs?: number; credentials?: RequestCredentials },
): Promise<T> {
	return await invokeRpc((rpc) => rpc.opsDispatch(command) as unknown as Promise<T>, options)
}

export function createUiRpcView(
	raw: RpcClientFactory,
	defaults: RpcClientCreateOptions = {},
): ExtensionUiRpcMap {
	// Important: capnweb http-batch sessions are short-lived. If we return the raw
	// stub object and users memoize it (e.g. `const rpc = transport.extensions.MyPlugin`),
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
						const client = raw({ ...defaults, signal })
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
	) as ExtensionUiRpcMap
}
