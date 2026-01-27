import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { configure, getConfig } from '@logtape/logtape'
import { createPluxelLogtapeConfig } from '@pluxel/core/logger'
import GraphQL from '@pluxel/graphql'
import { Context } from '@pluxel/hmr'
import { createLogStoreSink } from '@pluxel/hmr/logger'
import { LogtapeLoggerService } from '@pluxel/hmr/services'
import Wretch from '@pluxel/wretch'
import { MarketUI } from 'pluxel-plugin-market-ui'

if (process.env.PLUXEL_HMR_SSR === undefined) process.env.PLUXEL_HMR_SSR = 'true'

const here = dirname(fileURLToPath(import.meta.url))
const logsDir = join(here, '../logs')
const demoDir = join(here, './demo')
await mkdir(logsDir, { recursive: true })

if (!getConfig()) {
	await configure(
		createPluxelLogtapeConfig({
			preset: 'hmr',
			file: join(logsDir, 'hmr.log'),
			ui: createLogStoreSink({ minLevel: 'trace' }),
		}),
	)
}

const ctx = new Context({
	hmrService: {
		// Under Bun, Vite's "port in use → try another one" path can hang in some environments.
		// Use port=0 so the OS picks a free port deterministically.
		port: 0,
		// Load demo plugins eagerly, but keep `start()` fast: warmup runs best-effort in background.
		warmup: true,
		roots: [demoDir],
		exclude: [join(demoDir, '**/ui/**'), join(demoDir, 'env.ts')],
		// Builtins are plain ctors so TypeScript can validate them.
		builtins: [GraphQL, MarketUI, Wretch],
	},
	registry: {
		pluginCTXIsolate: [LogtapeLoggerService],
	},
})

await ctx.hmrService.start()
ctx.logger.info`HMR host ready`
