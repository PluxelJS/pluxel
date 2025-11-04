import { Context } from '@pluxel/core'
import { PluginA, PluginC } from './plugins'
import { PinoLoggerService } from '../src/services'

if (process.env.PLUXEL_HMR_SSR === undefined) {
	process.env.PLUXEL_HMR_SSR = 'true'
}

const ctx = new Context({
	hmrService: { dir: ['./tests/plugins'] },
	registry: {
		plugigCTXIsolate: [PinoLoggerService],
	},
})
async function bootstrap() {
	// …pluxel 初始化…
	const hmr = ctx.hmrService
	await hmr.start() // ← 这一步把 Vite 真正「跑」起来
	// 如果你有其他服务，比如 Hono，也在这里启动
}
bootstrap()
setTimeout(() => {
	console.log(ctx.loader.isRunning(PluginC)) // true
}, 5000)
ctx.honoService.modifyApp((app) => {
	app.get('/pluginadd', (c) => {
		return c.text('lastone')
	})
})

ctx.logger.info({ mySet: new Set([1, 2, 3]), myMap: new Map([['a', 1]]) })
