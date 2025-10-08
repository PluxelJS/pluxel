import { hc, type InferResponseType } from 'hono/client'
import type { SuccessStatusCode } from 'hono/utils/http-status'
import type { AppType } from '../../../hmr/src/api/hono/index'

export type { InferRequestType, InferResponseType } from 'hono/client'
// 相对路径，dev 通过 vite 代理，运行时同源
export const client = hc<AppType>('/api')

export type InferSuccessResponse<T> = InferResponseType<T, SuccessStatusCode>
