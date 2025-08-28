import { dehydrate } from '@tanstack/react-query'
import { Hono } from 'hono'
import type { AppEnv } from '../../hmr/src/services/hono/env'
import { App } from './app'
import { client } from './app/rpc'
import { queryClient } from './queryClient'
import { renderMiddleware } from './render'

const ssrApp = new Hono<AppEnv>()

// 1) 每次请求都先 new QueryClient，存到 c.env
ssrApp.use('*', (c, next) => {
	c.set('qc', queryClient)
	return renderMiddleware(c, next)
})

// 2) /plugin/:name 只做 prefetch  dehydrate  渲染 App
ssrApp.get('/plugins', async (c) => {
	const qc = c.var.qc

	// 预取：详情  列表  分组（确保 PluginList 首帧结构一致）
	await Promise.all([
		qc.prefetchQuery({
			queryKey: ['plugins'],
			queryFn: async () => (await client.plugins.$get()).json(),
		}),
		qc.prefetchQuery({
			queryKey: ['plugins', 'groups'],
			queryFn: async () => (await client.plugins.groups.$get({ json: [] })).json(),
		}),
	])

	// 序列化 cache
	c.set('dehydratedState', dehydrate(qc))

	// 用你的 SPA 根组件去渲染，里面包含了 plugin 路由
	return c.render(<App />)
})

// 3) 其他路由交给 SPA
ssrApp.get('*', (c) => c.render(<App />))

export { ssrApp }
