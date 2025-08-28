import { hc, type InferResponseType } from 'hono/client'
import type { SuccessStatusCode } from 'hono/utils/http-status'
import type { AppType } from './api'

export type { InferRequestType, InferResponseType } from 'hono/client'
export const client = hc<AppType>('http://localhost:3000/api')

export type InferSuccessResponse<T> = InferResponseType<T, SuccessStatusCode>
