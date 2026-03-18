import { existsSync } from 'node:fs'
import { copyFile, mkdir } from 'node:fs/promises'
import { dirname, resolve as resolvePath } from 'pathe'

import { SnapshotPlugin } from '@pluxel/snapshot'
import { MarketUI } from 'pluxel-plugin-market-ui'

import { ensurePluxelLogging } from '@pluxel/runtime/logger'
import { resolveProfiledPath, resolveRuntimeStoragePaths } from '@pluxel/runtime/internal'

import { repoRoot, runtimeEntry } from './_runtime-dist.mjs'
import { startFetchHostServer } from './_serve-fetch-host.mjs'

const { Context } = await import(runtimeEntry)
process.chdir(repoRoot)

const activeProfile = process.env.PLUXEL_RUNTIME_PROFILE ?? 'plugins-host-managed'
const bindHost = process.env.PLUXEL_HOST_BIND ?? '127.0.0.1'
const bindPort = Number(process.env.PLUXEL_HOST_PORT ?? '3310')

const storage = resolveRuntimeStoragePaths(repoRoot, {
	configFile: 'packages/plugins/host/.pluxel/managed/{profile}/config.json',
	pluginDataDir: 'packages/plugins/host/.pluxel/managed/plugin-data',
	packageStateFile: 'packages/plugins/host/.pluxel/managed/package-state.json',
	logsDir: 'packages/plugins/host/logs',
})

await mkdir(storage.logsDir, { recursive: true })
await ensurePluxelLogging({
	preset: 'core',
	file: storage.logFile,
	ui: true,
	debug: ['pluxel:runtime:*'],
})

const materializeProfiledFile = async (basePath, { profile, seedFile } = {}) => {
	const resolved = resolveProfiledPath(basePath, profile)
	await mkdir(dirname(resolved.path), { recursive: true })
	if (seedFile !== false && seedFile && !existsSync(resolved.path)) {
		const seedAbs = resolvePath(seedFile)
		if (existsSync(seedAbs)) await copyFile(seedAbs, resolved.path)
	}
	return resolved
}

await materializeProfiledFile(storage.configFile, { profile: activeProfile, seedFile: false })

const builtins = [
	{
		plugin: SnapshotPlugin,
		moduleId: '@pluxel/snapshot',
		exportKey: 'SnapshotPlugin',
		enable: true,
	},
	{
		plugin: MarketUI,
		moduleId: 'pluxel-plugin-market-ui',
		exportKey: 'MarketUI',
		enable: true,
	},
]

const ctx = new Context({
	profile: activeProfile,
	configService: {
		mode: 'file',
		path: storage.configFile,
	},
	pluginData: {
		dir: storage.pluginDataDir,
	},
	packageService: {
		policy: { allowInstall: false, allowUninstall: false },
		state: { enabled: false, file: storage.packageStateFile },
	},
	http: {
		controlPlane: { web: true, rpc: true, sse: true, auth: 'none' },
		uiAssets: 'static-built',
	},
	extensionService: { mode: 'registry-only' },
})

await ctx.loader.preloadPlugins(builtins, { strict: true, commit: true })

const server = await startFetchHostServer({
	host: bindHost,
	port: bindPort,
	fetch: (request) => ctx.http.fetch(request),
})

ctx.logger
	.info`Managed host ready (profile=${activeProfile}, url=${server.baseUrl}, config=${storage.configFile})`

let closing = false
async function shutdown(signal) {
	if (closing) return
	closing = true
	ctx.logger.info`Stopping managed host (${signal})`
	await server.close()
	process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
