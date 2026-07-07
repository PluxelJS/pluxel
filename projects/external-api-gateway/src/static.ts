import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { ensurePluxelLogging } from '@pluxel/runtime/logger'
import { bootstrapHostVault } from '@pluxel/runtime/services/vault'
import '@pluxel/runtime/services/web-management'
import { createStaticRuntime } from '@pluxel/runtime-static'
import staticRuntime from './pluxel.static.ts'
import { installShutdown, startFetchHostServer } from './server.ts'

const bindHost = process.env.PLUXEL_HOST_BIND ?? '127.0.0.1'
const bindPort = Number(process.env.PLUXEL_HOST_PORT ?? '3313')
const projectRoot = resolve(import.meta.dirname, '..')
const logsDir = resolve(projectRoot, 'logs')
const logFile = resolve(logsDir, 'runtime.log')

await mkdir(logsDir, { recursive: true })
await ensurePluxelLogging({
	preset: 'core',
	file: logFile,
	ui: true,
	debug: ['pluxel:runtime:*'],
})

const runtime = await createStaticRuntime(staticRuntime)
await bootstrapHostVault(runtime.ctx)

const server = await startFetchHostServer({
	host: bindHost,
	port: bindPort,
	fetch: runtime.fetch,
})

runtime.ctx.logger.info('External API gateway runtime ready', {
	profile: process.env.PLUXEL_RUNTIME_PROFILE ?? 'external-api-gateway',
	url: server.baseUrl,
})

installShutdown(async (signal) => {
	runtime.ctx.logger.info('Stopping external API gateway runtime', { signal })
	await server.close()
	await runtime.stop()
})
