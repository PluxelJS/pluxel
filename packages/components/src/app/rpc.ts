import { getHmrWebClient } from '@pluxel/hmr-web'

// Web API（Rest/RPC/SSE）
export * from '@pluxel/hmr-web'
export * from '@pluxel/hmr-web/react'

// App default API client (shared singleton)
export const client = getHmrWebClient().api
