import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { ensurePluxelLogging } from '@pluxel/runtime/logger'
import '@pluxel/runtime/services/vault'
import { createStaticRuntime } from '@pluxel/runtime-static'
import staticRuntime from './pluxel.static.ts'
import { installShutdown, startFetchHostServer } from './server.ts'

const host = process.env.PLUXEL_HOST_BIND ?? '127.0.0.1'
const port = Number(process.env.PLUXEL_HOST_PORT ?? 3314)
const projectRoot = resolve(import.meta.dirname, '..')
const logsDir = resolve(projectRoot, 'logs')

process.chdir(projectRoot)

await mkdir(logsDir, { recursive: true })
await ensurePluxelLogging({
	preset: 'core',
	file: resolve(logsDir, 'runtime.log'),
	ui: true,
	debug: ['pluxel:runtime:*', 'chatbots:*'],
})

const runtime = await createStaticRuntime(staticRuntime)

const vault = await (
	runtime.ctx.root as unknown as {
		vaultAdmin: { describe(): Promise<{ unlocked: boolean }> }
	}
).vaultAdmin.describe()
if (!vault.unlocked) throw new Error('Chatbots requires an unlocked Pluxel vault.')
const server = await startFetchHostServer({ host, port, fetch: runtime.fetch })

runtime.ctx.logger.info('Chatbots runtime ready', {
	url: server.baseUrl,
	enabledPlugins: runtime.ctx.runtimeState.snapshot().enabled,
})
installShutdown(async (signal) => {
	runtime.ctx.logger.info('Stopping chatbots runtime', { signal })
	await server.close()
	await runtime.stop()
})
