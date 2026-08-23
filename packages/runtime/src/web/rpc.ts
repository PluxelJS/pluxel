import type { RpcStub } from 'capnweb'
import type { RuntimeRpcApi, WorkbenchRpcView } from './internal-protocol'
import {
	createRpcClient as createGenericRpcClient,
	createRpcClientFactory as createGenericRpcClientFactory,
	createRpcTimeout,
	disposeRpcClient,
	invokeRpc as invokeGenericRpc,
	rpcErrorMessage,
	type RpcClientCreateOptions,
	type RpcClientFactory as GenericRpcClientFactory,
} from './rpc-session'

export { rpcErrorMessage }
export type { RpcClientCreateOptions }

export type RuntimeRpcStub = RpcStub<RuntimeRpcApi>

export function createRpcClient(
	rpcBase?: string,
	options: RpcClientCreateOptions = {},
): RuntimeRpcStub {
	return createGenericRpcClient<RuntimeRpcApi>(rpcBase, options)
}

export type RpcClientFactory = (options?: RpcClientCreateOptions) => RuntimeRpcStub

export function createRpcClientFactory(rpcBase?: string): RpcClientFactory {
	return createGenericRpcClientFactory<RuntimeRpcApi>(
		rpcBase,
	) as GenericRpcClientFactory<RuntimeRpcApi>
}

export async function invokeRpc<T>(
	runner: (client: RuntimeRpcStub) => Promise<T>,
	options?: { rpcBase?: string; timeoutMs?: number; credentials?: RequestCredentials },
): Promise<T> {
	return await invokeGenericRpc<RuntimeRpcApi, T>(runner, options)
}

export function createWorkbenchRpcView(
	raw: RpcClientFactory,
	options: RpcClientCreateOptions & { assertActive?: () => void } = {},
): WorkbenchRpcView {
	const { assertActive, ...defaults } = options
	// Important: capnweb http-batch sessions are short-lived. If we return the raw
	// stub object and users memoize it (e.g. `const rpc = transport.extensions.MyPlugin`),
	// the session may already be ended when the next interaction happens.
	//
	// To make this ergonomic and safe, we return a stable proxy where each method
	// call creates a fresh session.
	const namespaceCache = new Map<string, unknown>()

	const getNamespaceProxy = (grantId: string) => {
		const existing = namespaceCache.get(grantId)
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
						assertActive?.()
						const { signal, clear } = createRpcTimeout()
						const client = raw({ ...defaults, signal })
						// IMPORTANT: preserve `this` grantId for capnweb stubs.
						// Optional-chaining call like `obj?.[method]?.()` can lose the receiver,
						// which may break capnweb's dynamic dispatch.
						const nsTarget = (client as any).workbenchRpc(grantId)
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

		namespaceCache.set(grantId, nsProxy)
		return nsProxy
	}

	return new Proxy(
		{},
		{
			get(_target, grantId) {
				if (typeof grantId !== 'string') return undefined
				return getNamespaceProxy(grantId)
			},
		},
	) as WorkbenchRpcView
}
