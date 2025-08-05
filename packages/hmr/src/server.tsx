import { App } from './app'
import { client } from './app/rpc'
import { renderMiddleware } from './render'
import type { AppEnv } from '../../hmr/src/services/hono/env'
import { Hono } from 'hono'
import { dehydrate, QueryClient } from '@tanstack/react-query'

const ssrApp = new Hono<AppEnv>()

// 1) 每次请求都先 new QueryClient，存到 c.env
ssrApp.use('*', (c, next) => {
	c.set('qc', new QueryClient())
	return renderMiddleware(c, next)
})

// 2) /plugin/:name 只做 prefetch + dehydrate + 渲染 App
ssrApp.get('/plugin/:name', async (c) => {
	const name = c.req.param('name')!
	const qc = c.var.qc

	// 在服务器端预取
	await qc.prefetchQuery({
		queryKey: ['plugins', name],
		queryFn: async () => {
			const res = await client.plugins[':name'].$get({ param: { name } })
			return await res.json()
		},
	})

	// 序列化 cache
	c.set('dehydratedState', dehydrate(qc))

	// 用你的 SPA 根组件去渲染，里面包含了 plugin 路由
	return c.render(<App />)
})

// 3) 其他路由交给 SPA
ssrApp.get('*', (c) => c.render(<App />))

export { ssrApp }
