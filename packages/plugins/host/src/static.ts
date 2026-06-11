import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createStaticRuntimeHost } from '@pluxel/runtime-static'
import { ensurePluxelLogging } from '@pluxel/runtime/logger'
import { resolveRuntimeStoragePaths } from '@pluxel/runtime/internal'
import { dirname, resolve } from 'pathe'

import staticRuntime, { staticDemoEnabledPlugins } from './pluxel.static'
import {
	installShutdown,
	startFetchHostServer,
} from './server'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../../..')
process.chdir(repoRoot)

const activeProfile = process.env.PLUXEL_RUNTIME_PROFILE ?? 'plugins-host-static'
const bindHost = process.env.PLUXEL_HOST_BIND ?? '127.0.0.1'
const bindPort = Number(process.env.PLUXEL_HOST_PORT ?? '3310')

const storage = resolveRuntimeStoragePaths(repoRoot, {
	configFile: 'packages/plugins/host/.pluxel/static/{profile}/config.json',
	pluginDataDir: 'packages/plugins/host/.pluxel/static/plugin-data',
	logsDir: 'packages/plugins/host/logs',
})

await mkdir(storage.logsDir, { recursive: true })
await ensurePluxelLogging({
	preset: 'core',
	file: storage.logFile,
	ui: true,
	debug: ['pluxel:runtime:*'],
})

const host = await createStaticRuntimeHost(staticRuntime, {
	configService: {
		mode: 'memory',
		snapshot: { enabled: staticDemoEnabledPlugins },
	},
	context: {
		profile: activeProfile,
		logger: { preset: 'core' },
		pluginData: {
			dir: storage.pluginDataDir,
		},
		http: {
			controlPlane: { web: true, rpc: true, sse: true },
			uiAssets: 'static-built',
		},
		extensionService: { enabled: false },
	},
})

const startup = await host.start()
const server = await startFetchHostServer({
	host: bindHost,
	port: bindPort,
	fetch: (request) => host.ctx.http.fetch(request),
})

host.ctx.logger.info('Static runtime host ready', {
	profile: activeProfile,
	url: server.baseUrl,
	startup: startup.entries.map(({ name, status }) => `${name}:${status}`),
})

const watchSignals = installShutdown('static host', async (signal) => {
	host.ctx.logger.info('Stopping static host', { signal })
	await server.close()
	await host.stop()
})
watchSignals(async (label, error) => {
	host.ctx.logger.error(label, { error })
})
