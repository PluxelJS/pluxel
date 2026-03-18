import { pathToFileURL } from 'node:url'

import { resolve } from 'pathe'

import { repoRoot } from './_runtime-dist.mjs'
import { startFetchHostServer } from './_serve-fetch-host.mjs'

process.chdir(repoRoot)

const entry = resolve(
	repoRoot,
	process.env.PLUXEL_FROZEN_ENTRY ?? 'packages/plugins/host/.pluxel/frozen/frozen-host.mjs',
)
const bindHost = process.env.PLUXEL_HOST_BIND ?? '127.0.0.1'
const bindPort = Number(process.env.PLUXEL_HOST_PORT ?? '3310')

const mod = await import(pathToFileURL(entry).href)
const ctx = mod.default

if (!ctx?.http?.fetch) {
	throw new Error(`Frozen host entry does not export a runnable context: ${entry}`)
}

const activeProfile = ctx.profile ?? process.env.PLUXEL_RUNTIME_PROFILE ?? 'plugins-host-frozen'
const server = await startFetchHostServer({
	host: bindHost,
	port: bindPort,
	fetch: (request) => ctx.http.fetch(request),
})

ctx.logger.info`Frozen host ready (profile=${activeProfile}, url=${server.baseUrl}, entry=${entry})`

let closing = false
async function shutdown(signal) {
	if (closing) return
	closing = true
	ctx.logger.info`Stopping frozen host (${signal})`
	await server.close()
	process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
