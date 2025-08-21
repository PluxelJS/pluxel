import { hc, type InferResponseType } from 'hono/client'
import type { AppType } from './api'
import type { SuccessStatusCode } from 'hono/utils/http-status'

export type { InferResponseType, InferRequestType } from 'hono/client'
export const client = hc<AppType>('http://localhost:3000/api')

export type InferSuccessResponse<T> = InferResponseType<T, SuccessStatusCode>
