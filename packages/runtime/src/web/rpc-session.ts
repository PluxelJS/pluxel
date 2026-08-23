import { newHttpBatchRpcSession, type RpcStub } from 'capnweb'
import { RUNTIME_INTERNAL_API_BASE } from './paths'

export type RpcClientCreateOptions = Readonly<{
	signal?: AbortSignal
	/** Ensure cookies are sent (browser); defaults to `same-origin`. */
	credentials?: RequestCredentials
}>

export function createRpcClient<TApi extends object>(
	rpcBase = `${RUNTIME_INTERNAL_API_BASE}/rpc`,
	options: RpcClientCreateOptions = {},
): RpcStub<TApi> {
	const { signal, credentials } = options
	const urlOrRequest =
		signal || credentials !== undefined
			? new Request(rpcBase, {
					signal,
					credentials: credentials ?? 'same-origin',
					headers: {
						'Content-Type': 'text/plain; charset=utf-8',
					},
				})
			: rpcBase
	return newHttpBatchRpcSession<TApi>(urlOrRequest as any)
}

export type RpcClientFactory<TApi extends object> = (
	options?: RpcClientCreateOptions,
) => RpcStub<TApi>

export function createRpcClientFactory<TApi extends object>(
	rpcBase = `${RUNTIME_INTERNAL_API_BASE}/rpc`,
): RpcClientFactory<TApi> {
	return (options) => createRpcClient<TApi>(rpcBase, options)
}

export function disposeRpcClient(client: object): void {
	const disposer =
		(client as any)[Symbol.dispose] ??
		(client as any)[Symbol.asyncDispose] ??
		(client as any).dispose
	if (typeof disposer !== 'function') return
	try {
		disposer.call(client)
	} catch {}
}

const DEFAULT_RPC_TIMEOUT_MS = 20_000

export function createRpcTimeout(timeoutMs = DEFAULT_RPC_TIMEOUT_MS): Readonly<{
	signal?: AbortSignal
	clear(): void
}> {
	if (timeoutMs <= 0) return { signal: undefined, clear: () => {} }
	if (typeof AbortController === 'undefined') {
		return { signal: undefined, clear: () => {} }
	}

	const controller = new AbortController()
	const timer = setTimeout(() => {
		try {
			controller.abort(new Error(`[runtime RPC] timeout after ${timeoutMs}ms`))
		} catch {
			controller.abort()
		}
	}, timeoutMs)
	return Object.freeze({
		signal: controller.signal,
		clear: () => clearTimeout(timer),
	})
}

export async function invokeRpc<TApi extends object, TResult>(
	runner: (client: RpcStub<TApi>) => Promise<TResult>,
	options?: Readonly<{
		rpcBase?: string
		timeoutMs?: number
		credentials?: RequestCredentials
	}>,
): Promise<TResult> {
	const rpcBase = options?.rpcBase ?? `${RUNTIME_INTERNAL_API_BASE}/rpc`
	const timeout = createRpcTimeout(options?.timeoutMs)
	const client = createRpcClient<TApi>(rpcBase, {
		signal: timeout.signal,
		credentials: options?.credentials,
	})
	try {
		return await runner(client)
	} catch (error) {
		console.error('[runtime RPC] 调用失败', error)
		throw error
	} finally {
		timeout.clear()
		disposeRpcClient(client)
	}
}

export function rpcErrorMessage(error: unknown, fallback = 'RPC 调用失败'): string {
	if (error instanceof Error) return error.message || fallback
	if (typeof error === 'string') return error
	return fallback
}
