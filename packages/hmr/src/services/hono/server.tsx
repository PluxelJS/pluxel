import { dehydrate } from '@tanstack/react-query'
// server.ts
import { Hono } from 'hono'
import App from './app/app'
import { Plugin } from './app/plugin'
import { type Env, createQueryClient } from './env'
import { renderMiddleware } from './render'

// 模拟后端数据
async function fetchPluginData(name: string) {
	return { name, desc: `这是插件 ${name} 的服务端描述` }
}

const app = new Hono<Env>()

// 1) 每次请求都先 new QueryClient，存到 c.env
app.use('*', (c, next) => {
	c.set('qc', createQueryClient())
	return renderMiddleware(c, next)
})

// 2) /plugin/:name 只做 prefetch + dehydrate + 渲染 App
app.get('/plugin/:name', async (c) => {
	const name = c.req.param('name')!
	const qc = c.var.qc

	// 在服务器端预取
	await qc.prefetchQuery(['plugin', name], () => fetchPluginData(name))

	// 序列化 cache
	c.set('dehydratedState', dehydrate(qc))

	// 用你的 SPA 根组件去渲染，里面包含了 plugin 路由
	return c.render(<App />)
})

// 3) 其他路由交给 SPA
app.get('*', (c) => c.render(<App />))

export { app }
