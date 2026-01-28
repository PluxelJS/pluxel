import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { configure, getConfig } from '@logtape/logtape'
import { createPluxelLogtapeConfig } from '@pluxel/core/logger'
import GraphQL from '@pluxel/graphql'
import Snapshot from '@pluxel/snapshot'
import { Context } from '@pluxel/hmr'
import { applyHmrEnvOverrides } from '@pluxel/hmr/host'
import { createLogStoreSink } from '@pluxel/hmr/logger'
import { LogtapeLoggerService } from '@pluxel/hmr/services'
import Wretch from '@pluxel/wretch'
import { MarketUI } from 'pluxel-plugin-market-ui'

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
	hmrService: applyHmrEnvOverrides({
		port: 3000,
		// Load demo plugins eagerly, but keep `start()` fast: warmup runs best-effort in background.
		warmup: true,
		roots: [demoDir],
		exclude: [join(demoDir, '**/ui/**'), join(demoDir, 'env.ts')],
		// Builtins are plain ctors so TypeScript can validate them.
		builtins: [
			{ plugin: GraphQL, moduleId: '@pluxel/graphql', exportKey: 'default' },
			{ plugin: Snapshot, moduleId: '@pluxel/snapshot', exportKey: 'default' },
			{ plugin: MarketUI, moduleId: 'pluxel-plugin-market-ui', exportKey: 'MarketUI' },
			{ plugin: Wretch, moduleId: '@pluxel/wretch', exportKey: 'default' },
		],
	}),
	registry: {
		pluginCTXIsolate: [LogtapeLoggerService],
	},
})

await ctx.hmrService.start()
ctx.logger.info`HMR host ready`
