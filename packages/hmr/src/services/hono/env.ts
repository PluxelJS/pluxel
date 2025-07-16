import type { Context } from '@pluxel/core'
import type { Hono } from 'hono'

import {
	type DefaultOptions,
	type DehydratedState,
	QueryClient,
} from '@tanstack/react-query'

// 全局定义的默认配置
const defaultOptions: DefaultOptions = {
	queries: {
		// SSR 时不自动重试
		retry: false,
		// 默认缓存时长
		cacheTime: 1000 * 60 * 5,
		// 默认过期时间
		staleTime: 1000 * 30,
	},
}

export function createQueryClient() {
	return new QueryClient({ defaultOptions })
}

export type Env = {
	Variables: {
		plugin_ctx: Context
		qc: QueryClient
		dehydratedState: DehydratedState | undefined
	}
}
export type HonoType = Hono<Env>
