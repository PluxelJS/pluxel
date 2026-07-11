import { kookApiEndpoints } from './endpoints.macro.ts' with { type: 'macro' }
import type { HttpMethod, KookAutoApi } from './types.ts'

export type KookEndpoint = readonly [name: keyof KookAutoApi, method: HttpMethod, path: string]

export const KOOK_ENDPOINTS = kookApiEndpoints() as readonly KookEndpoint[]
