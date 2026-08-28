import { RpcSession, type RpcStub, type RpcTransport } from 'capnweb'
import { RUNTIME_INTERNAL_API_BASE } from './paths'
import type { RuntimeFetch } from './admin-access'

export type RpcClientCreateOptions = Readonly<{
	signal?: AbortSignal
	/** Ensure cookies are sent (browser); defaults to `same-origin`. */
	credentials?: RequestCredentials
	/** Fetch implementation used for the actual HTTP batch request. */
	fetch?: RuntimeFetch
}>

class HttpBatchTransport implements RpcTransport {
	private readonly task: Promise<void>
	private outgoing: string[] | null = []
	private incoming: string[] | null = null
	private aborted: unknown

	constructor(private readonly sendBatch: (messages: readonly string[]) => Promise<string[]>) {
		this.task = this.schedule()
	}

	async send(message: string): Promise<void> {
		this.outgoing?.push(message)
	}

	async receive(): Promise<string> {
		if (!this.incoming) await this.task
		const message = this.incoming?.shift()
		if (message !== undefined) return message
		throw new Error('Batch RPC request ended.')
	}

	abort(reason: unknown): void {
		this.aborted = reason
	}

	private async schedule(): Promise<void> {
		await new Promise<void>((resolve) => setTimeout(resolve, 0))
		if (this.aborted !== undefined) throw this.aborted
		const batch = this.outgoing ?? []
		this.outgoing = null
		this.incoming = await this.sendBatch(batch)
	}
}

export function createRpcClient<TApi extends object>(
	rpcBase = `${RUNTIME_INTERNAL_API_BASE}/rpc`,
	options: RpcClientCreateOptions = {},
): RpcStub<TApi> {
	const { signal, credentials, fetch = globalThis.fetch.bind(globalThis) } = options
	const transport = new HttpBatchTransport(async (batch) => {
		const response = await fetch(rpcBase, {
			method: 'POST',
			body: batch.join('\n'),
			signal,
			credentials: credentials ?? 'same-origin',
			headers: { 'Content-Type': 'text/plain; charset=utf-8' },
		})
		if (!response.ok) {
			await response.body?.cancel().catch((): undefined => undefined)
			throw new Error(`RPC request failed: ${response.status} ${response.statusText}`)
		}
		const body = await response.text()
		return body ? body.split('\n') : []
	})
	return new RpcSession<TApi>(transport).getRemoteMain()
}

export type RpcClientFactory<TApi extends object> = (
	options?: RpcClientCreateOptions,
) => RpcStub<TApi>

export function createRpcClientFactory<TApi extends object>(
	rpcBase = `${RUNTIME_INTERNAL_API_BASE}/rpc`,
	defaults: RpcClientCreateOptions = {},
): RpcClientFactory<TApi> {
	return (options) => createRpcClient<TApi>(rpcBase, { ...defaults, ...options })
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
		fetch?: RuntimeFetch
	}>,
): Promise<TResult> {
	const rpcBase = options?.rpcBase ?? `${RUNTIME_INTERNAL_API_BASE}/rpc`
	const timeout = createRpcTimeout(options?.timeoutMs)
	const client = createRpcClient<TApi>(rpcBase, {
		signal: timeout.signal,
		credentials: options?.credentials,
		fetch: options?.fetch,
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
