import { Context } from '@pluxel/hmr'
import { PinoLoggerService } from '@pluxel/hmr/services'
import { PluginA, PluginC } from './plugins'

if (process.env.PLUXEL_HMR_SSR === undefined) {
	process.env.PLUXEL_HMR_SSR = 'true'
}

const ctx = new Context({
	hmrService: {
		dir: ['./tests/plugins'],
		log: {
			debugNamespaces: [
				'pluxel:hmr:modules',
				'pluxel:hmr:time',
				'pluxel:hmr:time:entry',
				'pluxel:hmr:warmup',
				'pluxel:hmr:batch',
				'pluxel:hmr:graph',
			],
		},
	},
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
setTimeout(async () => {
	/* const resolution = await ctx.scanService.resolveEntryByName('pluxel-plugin-redis')
	if (resolution.ok) {
		await ctx.loader.replaceModule(resolution.dir, await import(resolution.entry))
	} */
	ctx.internalGraphql.scheduleRebuild()
	// const a = await ctx.packageService.load('pluxel-plugin-redis')
	// console.log(a)
}, 5000)
ctx.honoService.modifyApp((app) => {
	app.get('/pluginadd', (c) => {
		return c.text('lastone')
	})
})

ctx.logger.info({ mySet: new Set([1, 2, 3]), myMap: new Map([['a', 1]]) })
