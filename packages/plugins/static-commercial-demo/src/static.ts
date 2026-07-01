import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import '@pluxel/runtime/services/web-management'
import { createStaticRuntime } from '@pluxel/runtime-static'
import { ensurePluxelLogging } from '@pluxel/runtime/logger'
import staticRuntime from './pluxel.static.ts'
import { installShutdown, startFetchHostServer } from './server.ts'

const bindHost = process.env.PLUXEL_HOST_BIND ?? '127.0.0.1'
const bindPort = Number(process.env.PLUXEL_HOST_PORT ?? '3312')
const repoRoot = resolve(import.meta.dirname, '../../../..')
const logsDir = resolve(repoRoot, 'packages/plugins/static-commercial-demo/logs')
const logFile = resolve(logsDir, 'runtime.log')

await mkdir(logsDir, { recursive: true })
await ensurePluxelLogging({
	preset: 'core',
	file: logFile,
	ui: true,
	debug: ['pluxel:runtime:*'],
})

const runtime = await createStaticRuntime(staticRuntime)
const server = await startFetchHostServer({
	host: bindHost,
	port: bindPort,
	fetch: runtime.fetch,
})

runtime.ctx.logger.info('Static commercial runtime ready', {
	profile: process.env.PLUXEL_RUNTIME_PROFILE ?? 'plugins-static-commercial-demo',
	url: server.baseUrl,
})

installShutdown(async (signal) => {
	runtime.ctx.logger.info('Stopping static commercial runtime', { signal })
	await server.close()
	await runtime.stop()
})
