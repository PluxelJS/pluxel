import type { ExtensionContext, PluginUIModule } from '../../components/src/index'
export type { ExtensionContext }
/**
 * Helper to define a plugin UI module with full type inference.
 * ```ts
 * import { definePluginUIModule } from '@pluxel/hmr/web'
 *
 * export default definePluginUIModule({
 *   extensions: [...],
 * })
 * ```
 */
export function definePluginUIModule<T extends PluginUIModule>(module: T): T {
	return module
}

import type { RpcStub } from 'capnweb'
import { newHttpBatchRpcSession } from 'capnweb'
import type { HmrRpcApi } from './api/hono'
import type { RpcExtensions } from './services'
export const rawRpc = (): RpcStub<HmrRpcApi> => newHttpBatchRpcSession<HmrRpcApi>('/api/rpc')

export const rpc = (): RpcExtensions => rawRpc().ext

export async function invokeRpc<T>(runner: (client: RpcStub<HmrRpcApi>) => Promise<T>): Promise<T> {
	const client = rawRpc()
	try {
		return await runner(client)
	} catch (error) {
		console.error('[Plugin RPC] 调用失败', error)
		throw error
	}
}

export function rpcErrorMessage(error: unknown, fallback = 'RPC 调用失败'): string {
	if (error instanceof Error) {
		return error.message || fallback
	}
	if (typeof error === 'string') {
		return error
	}
	return fallback
}
