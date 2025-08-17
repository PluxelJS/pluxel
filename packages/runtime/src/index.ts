import { Context } from '@pluxel/hmr'
import { PinoLoggerService } from '@pluxel/hmr/services'

const ctx = new Context({
	hmrService: { dir: ['./src/plugins', './src/services'] },
	registry: {
		plugigCTXIsolate: [PinoLoggerService],
	},
})
/* console.log(
	'%c🤪 ~ file: index.ts:6 []',
	'color: #608d96',
	await ctx.loader.getAllTsFiles(['./src/plugins']),
) */
/* 
ctx.registry.pluginRegistry.registerPlugin(PluginB)
await ctx.registry.commit()
 */ async function bootstrap() {
	// …pluxel 初始化…
	const hmr = ctx.hmrService
	await hmr.start() // ← 这一步把 Vite 真正「跑」起来
	// 如果你有其他服务，比如 Hono，也在这里启动
}
bootstrap()
setTimeout(() => console.log(ctx.loader.ctorMap), 1000)
ctx.honoService.modifyApp((app) => {
	app.get('/pluginadd', (c) => {
		return c.text('lastone')
	})
})
