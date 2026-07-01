import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import '@pluxel/runtime/services/web-management'
import { createStaticRuntime } from '@pluxel/runtime-static'
import { ensurePluxelLogging } from '@pluxel/runtime/logger'
import { dirname, resolve } from 'pathe'

import staticRuntime from './pluxel.static'
import { installShutdown, startFetchHostServer } from './server'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../../..')
process.chdir(repoRoot)

const activeProfile = process.env.PLUXEL_RUNTIME_PROFILE ?? 'plugins-host-static'
const bindHost = process.env.PLUXEL_HOST_BIND ?? '127.0.0.1'
const bindPort = Number(process.env.PLUXEL_HOST_PORT ?? '3310')

const logsDir = resolve(repoRoot, 'packages/plugins/host/logs')
const storage = {
	logsDir,
	logFile: resolve(logsDir, 'runtime.log'),
}

await mkdir(storage.logsDir, { recursive: true })
await ensurePluxelLogging({
	preset: 'core',
	file: storage.logFile,
	ui: true,
	debug: ['pluxel:runtime:*'],
})

const runtime = await createStaticRuntime(staticRuntime)

runtime.ctx.root.verification.assertCanBindHost(bindHost)
const server = await startFetchHostServer({
	host: bindHost,
	port: bindPort,
	fetch: runtime.fetch,
})

runtime.ctx.logger.info('Static runtime host ready', {
	profile: activeProfile,
	url: server.baseUrl,
})

const watchSignals = installShutdown('static host', async (signal) => {
	runtime.ctx.logger.info('Stopping static host', { signal })
	await server.close()
	await runtime.stop()
})
watchSignals(async (label, error) => {
	runtime.ctx.logger.error(label, { error })
})
