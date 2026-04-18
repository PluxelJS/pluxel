import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { copyFile, mkdir } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { dirname, resolve } from 'pathe'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../../..')
process.chdir(repoRoot)

function toFetchHeaders(headers) {
	const out = new Headers()
	for (const [key, value] of Object.entries(headers)) {
		if (value === undefined) continue
		if (Array.isArray(value)) {
			for (const item of value) out.append(key, item)
			continue
		}
		out.set(key, String(value))
	}
	return out
}

function toFetchRequest(req, baseUrl) {
	const url = new URL(req.url ?? '/', baseUrl)
	const method = req.method ?? 'GET'
	const init = {
		method,
		headers: toFetchHeaders(req.headers),
		body: method === 'GET' || method === 'HEAD' ? undefined : Readable.toWeb(req),
	}
	if (init.body) init.duplex = 'half'
	return new Request(url, init)
}

async function writeFetchResponse(res, response) {
	res.statusCode = response.status
	for (const [key, value] of response.headers) {
		res.setHeader(key, value)
	}

	if (!response.body) {
		res.end()
		return
	}

	await new Promise((resolvePromise, reject) => {
		Readable.fromWeb(response.body)
			.on('error', reject)
			.pipe(res)
			.on('finish', resolvePromise)
			.on('error', reject)
	})
}

async function startFetchHostServer(options) {
	const host = options.host ?? '127.0.0.1'
	const port = Number(options.port ?? 3310)
	const server = createServer(async (req, res) => {
		try {
			const request = toFetchRequest(req, `http://${host}:${port}`)
			const response = await options.fetch(request)
			await writeFetchResponse(res, response)
		} catch (error) {
			res.statusCode = 500
			res.setHeader('Content-Type', 'text/plain; charset=utf-8')
			res.end(error instanceof Error ? (error.stack ?? error.message) : String(error))
		}
	})

	await new Promise((resolvePromise, reject) => {
		server.once('error', reject)
		server.listen(port, host, () => {
			server.off('error', reject)
			resolvePromise()
		})
	})

	return {
		host,
		port,
		baseUrl: `http://${host}:${port}`,
		close: async () =>
			new Promise((resolvePromise, reject) =>
				server.close((error) => {
					if (error) {
						reject(error)
						return
					}

					resolvePromise()
				}),
			),
	}
}

function installShutdown(label, onClose) {
	let closing = false
	async function shutdown(signal) {
		if (closing) return
		closing = true
		await onClose(signal)
		process.exit(0)
	}

	process.on('SIGINT', () => void shutdown('SIGINT'))
	process.on('SIGTERM', () => void shutdown('SIGTERM'))

	return (messageLogger) => {
		process.on('uncaughtException', (error) => {
			void messageLogger(`${label} uncaught exception`, error)
		})
		process.on('unhandledRejection', (error) => {
			void messageLogger(`${label} unhandled rejection`, error)
		})
	}
}

async function materializeProfiledFile(basePath, options = {}) {
	const { resolveProfiledPath } = await import('@pluxel/runtime/internal')
	const resolved = resolveProfiledPath(basePath, options.profile)
	const seedFile = options.seedFile
	await mkdir(dirname(resolved.path), { recursive: true })
	if (seedFile === false || !seedFile || existsSync(resolved.path)) return resolved
	if (existsSync(seedFile)) await copyFile(seedFile, resolved.path)
	return resolved
}

async function startDevHost() {
	const { bootPlannedHmrHost, planHmrHostFromConfig } = await import('@pluxel/hmr/host')

	const activeProfile = process.env.PLUXEL_HMR_PROFILE ?? 'plugins-host'
	const configPath = process.env.PLUXEL_HMR_CONFIG ?? 'packages/plugins/host/pluxel.hmr.jsonc'

	const plan = await planHmrHostFromConfig({
		root: repoRoot,
		logsDir: 'packages/plugins/host/logs',
		chdir: false,
		configPath,
		profile: activeProfile,
	})
	const { ctx, hmr } = await bootPlannedHmrHost(plan)
	await hmr.start()
	ctx.logger.info`HMR host ready (profile=${activeProfile})`
}

async function startManagedHost() {
	const { Context } = await import('@pluxel/runtime')
	const { bootstrapHostVault } = await import('@pluxel/runtime/services')
	const { ensurePluxelLogging } = await import('@pluxel/runtime/logger')
	const { resolveRuntimeStoragePaths } = await import('@pluxel/runtime/internal')

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
	await materializeProfiledFile(storage.configFile, { profile: activeProfile, seedFile: false })

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
			controlPlane: { web: true, rpc: true, sse: true },
			uiAssets: 'static-built',
		},
		extensionService: { enabled: false },
	})
	await bootstrapHostVault(ctx)

	const server = await startFetchHostServer({
		host: bindHost,
		port: bindPort,
		fetch: (request) => ctx.http.fetch(request),
	})

	ctx.logger.info`Managed host ready (profile=${activeProfile}, url=${server.baseUrl})`

	const watchSignals = installShutdown('managed host', async (signal) => {
		ctx.logger.info`Stopping managed host (${signal})`
		await server.close()
	})
	watchSignals(async (label, error) => {
		ctx.logger.error(label, { error })
	})
}

async function startFrozenHost() {
	const { buildFrozenHost } = await import('@pluxel/runtime/frozen')
	const { ensurePluxelLogging } = await import('@pluxel/runtime/logger')

	const outDir = resolve(
		repoRoot,
		process.env.PLUXEL_FROZEN_OUT_DIR ?? 'packages/plugins/host/.pluxel/frozen',
	)
	const activeProfile = process.env.PLUXEL_RUNTIME_PROFILE ?? 'plugins-host-frozen'
	const bindHost = process.env.PLUXEL_HOST_BIND ?? '127.0.0.1'
	const bindPort = Number(process.env.PLUXEL_HOST_PORT ?? '3310')

	await ensurePluxelLogging({
		preset: 'core',
		ui: true,
		debug: ['pluxel:runtime:*'],
	})

	const res = await buildFrozenHost({
		outDir,
		profile: activeProfile,
		plugins: [],
		enabled: [],
		bootstrap: {
			controlPlane: {
				web: true,
				rpc: true,
				sse: true,
			},
			uiAssets: 'static-built',
		},
	})

	const mod = await import(pathToFileURL(res.entry).href)
	const ctx = mod.default

	if (!ctx?.http?.fetch) {
		throw new Error(`Frozen host entry does not export a runnable context: ${res.entry}`)
	}

	const server = await startFetchHostServer({
		host: bindHost,
		port: bindPort,
		fetch: (request) => ctx.http.fetch(request),
	})

	ctx.logger
		.info`Frozen host ready (profile=${activeProfile}, url=${server.baseUrl}, entry=${res.entry})`

	const watchSignals = installShutdown('frozen host', async (signal) => {
		ctx.logger.info`Stopping frozen host (${signal})`
		await server.close()
	})
	watchSignals(async (label, error) => {
		ctx.logger.error(label, { error })
	})
}

const mode = process.argv[2] ?? 'dev'

if (mode === 'dev') {
	await startDevHost()
} else if (mode === 'managed') {
	await startManagedHost()
} else if (mode === 'frozen') {
	await startFrozenHost()
} else {
	throw new Error(`Unknown host mode: ${mode}. Expected one of: dev, managed, frozen`)
}
