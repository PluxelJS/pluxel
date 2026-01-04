import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { configure } from '@logtape/logtape'
import { createPluxelPrettyConsoleSink, getRotatingFileSink, pluxelCategories } from '@pluxel/core/logger'
import { Context } from '@pluxel/hmr'
import { createLogStoreSink } from '@pluxel/hmr/logger'
import { LogtapeLoggerService } from '@pluxel/hmr/services'

if (process.env.PLUXEL_HMR_SSR === undefined) {
	process.env.PLUXEL_HMR_SSR = 'true'
}

const debugNamespaces = [
	'pluxel:hmr:modules',
	'pluxel:hmr:time',
	'pluxel:hmr:time:entry',
	'pluxel:hmr:warmup',
	'pluxel:hmr:batch',
	'pluxel:hmr:cache',
	'pluxel:hmr:graph',
] as const

const logsDir = join(dirname(fileURLToPath(import.meta.url)), '../logs')
await mkdir(logsDir, { recursive: true })

await configure({
	sinks: {
		console: createPluxelPrettyConsoleSink({
			pretty: { timestamp: 'time', prefix: 'name', includeCaller: true },
			// Only use Youch for loader/HMR/plugin-system errors to avoid async interleaving in general logs.
			youch: {
				minLevel: 'error',
				mode: 'inline',
				categoryPrefixes: [pluxelCategories.hmr, pluxelCategories.plugins],
			},
		}),
		file: getRotatingFileSink(join(logsDir, 'hmr.log')),
		ui: createLogStoreSink({ minLevel: 'trace' }),
	},
	loggers: [
		{ category: ['pluxel'], sinks: ['console', 'file'], lowestLevel: process.env.PLUXEL_LOG_LEVEL ?? 'info' },
		{ category: ['pluxel', 'hmr'], sinks: ['ui'], lowestLevel: 'trace' },
		{ category: ['pluxel', 'plugins'], sinks: ['ui'], lowestLevel: 'trace' },
		...debugNamespaces.map((ns) => ({ category: ns.split(':'), lowestLevel: 'debug' as const })),
		{ category: ['logtape', 'meta'], sinks: ['console'], lowestLevel: 'error' },
	],
})

const ctx = new Context({
	hmrService: {
		dir: ['./tests/plugins', './tests/ui-demos', './runtime-demos'],
		log: {
			debugNamespaces: [...debugNamespaces],
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
