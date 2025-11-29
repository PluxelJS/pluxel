import { newHttpBatchRpcSession, type RpcStub } from 'capnweb'
import { hc } from 'hono/client'
import type { HmrRpcApi } from '../../../hmr/src/api/hono'
import type { AppType } from '../../../hmr/src/api/hono/index'

export type { InferRequestType, InferResponseType } from 'hono/client'
// 相对路径，dev 通过 vite 代理，运行时同源
export const client = hc<AppType>('/api')

/**
 * HTTP batch RPC 会在创建后立刻发送一次请求，响应返回后即结束，
 * 因此不能复用同一个 stub。暴露一个工厂函数，每次需要调用 RPC 时
 * 重新创建 session，避免出现 "Batch RPC request ended" 错误。
 */
export const createRpcClient = (): RpcStub<HmrRpcApi> =>
	newHttpBatchRpcSession<HmrRpcApi>('/api/rpc')
