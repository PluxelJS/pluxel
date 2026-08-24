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

export function createWorkbenchRpcClient(
	raw: RpcClientFactory,
	grantId: string,
	options: RpcClientCreateOptions & { assertActive?: () => void } = {},
): WorkbenchRpcView {
	const { assertActive, ...defaults } = options
	// Important: capnweb http-batch sessions are short-lived. If we return the raw
	// stub object and users memoize it (e.g. `const rpc = transport.extensions.MyPlugin`),
	// the session may already be ended when the next interaction happens.
	//
	// Browser RPC method names are type-erased and supplied by the remote target. A Proxy keeps the
	// typed property-call API at this open-ended transport boundary without affecting backend owner
	// or lifecycle projection.
	const methodCache = new Map<string, unknown>()
	return new Proxy(
		{},
		{
			get(_target, method) {
				if (typeof method !== 'string' || method === 'then') return undefined
				const cached = methodCache.get(method)
				if (cached) return cached
				const fn = (...args: any[]) => {
					assertActive?.()
					const { signal, clear } = createRpcTimeout()
					let client: RuntimeRpcStub
					try {
						client = raw({ ...defaults, signal })
					} catch (error) {
						clear()
						throw error
					}
					let result: unknown
					try {
						const nsTarget = (client as any).workbenchRpc(grantId)
						const targetFn = nsTarget?.[method]
						result =
							typeof targetFn === 'function'
								? Reflect.apply(targetFn as any, nsTarget, args)
								: undefined
						if (result && typeof (result as any).then === 'function') {
							return Promise.resolve(result).finally(() => {
								clear()
								disposeRpcClient(client)
							})
						}
					} catch (error) {
						clear()
						disposeRpcClient(client)
						throw error
					}
					clear()
					disposeRpcClient(client)
					return result
				}
				methodCache.set(method, fn)
				return fn
			},
		},
	) as WorkbenchRpcView
}
