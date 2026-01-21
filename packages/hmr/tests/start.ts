import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@pluxel/hmr'
import { LogtapeLoggerService } from '@pluxel/hmr/services'

if (process.env.PLUXEL_HMR_SSR === undefined) {
	process.env.PLUXEL_HMR_SSR = 'true'
}

const logsDir = join(dirname(fileURLToPath(import.meta.url)), '../logs')
await mkdir(logsDir, { recursive: true })

const ctx = new Context({
	debug: ['pluxel:hmr:*'],
	hmrService: {
		dir: ['./tests/demo', './tests/plugins'],
		log: {
			// HMR defaults will auto-configure LogTape on first `hmr.start()` if the host didn't call `configure()`.
			logtape: { file: join(logsDir, 'hmr.log') },
		},
	},
	registry: {
		pluginCTXIsolate: [LogtapeLoggerService],
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

ctx.logger.with({ mySet: new Set([1, 2, 3]), myMap: new Map([['a', 1]]) }).info`dev log example`
