import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@pluxel/hmr'
import { LogtapeLoggerService } from '@pluxel/hmr/services'
import { GraphQLPlugin } from 'pluxel-plugin-graphql'
import { MarketUI } from 'pluxel-plugin-market-ui'
import { WretchPlugin } from 'pluxel-plugin-wretch'

if (process.env.PLUXEL_HMR_SSR === undefined) process.env.PLUXEL_HMR_SSR = 'true'

const here = dirname(fileURLToPath(import.meta.url))
const logsDir = join(here, '../logs')
const demoDir = join(here, './demo')
await mkdir(logsDir, { recursive: true })

const ctx = new Context({
	debug: ['pluxel:hmr:*'],
	hmrService: {
		dir: [demoDir],
		coldStart: 'background',
		builtins: [GraphQLPlugin, MarketUI, WretchPlugin],
		log: {
			logtape: { file: join(logsDir, 'hmr.log') },
		},
	},
	registry: {
		pluginCTXIsolate: [LogtapeLoggerService],
	},
})

await ctx.hmrService.start()
ctx.logger.info`HMR host ready`
