import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createStaticRuntimeHost } from '@pluxel/runtime-static'
import { installStaticRuntimeHmr } from '@pluxel/runtime-static/hmr'
import { resolveRuntimeStoragePaths } from '@pluxel/runtime/internal'
import { ensurePluxelLogging } from '@pluxel/runtime/logger'
import type { ViteDevServer } from 'vite'
import staticRuntime, { staticCommercialEnabledPlugins } from './pluxel.static.ts'

export interface StaticCommercialHost {
	fetch(request: Request): Promise<Response>
	stop(): Promise<void>
}

export async function createStaticCommercialHost(
	viteServer?: ViteDevServer,
): Promise<StaticCommercialHost> {
	const repoRoot = resolve(import.meta.dirname, '../../../..')
	const activeProfile = process.env.PLUXEL_RUNTIME_PROFILE ?? 'plugins-static-commercial-demo'

	const storage = resolveRuntimeStoragePaths(repoRoot, {
		configFile: 'packages/plugins/static-commercial-demo/.pluxel/static/{profile}/config.json',
		pluginDataDir: 'packages/plugins/static-commercial-demo/.pluxel/static/plugin-data',
		logsDir: 'packages/plugins/static-commercial-demo/logs',
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
			snapshot: { enabled: staticCommercialEnabledPlugins },
		},
		context: {
			profile: activeProfile,
			logger: { preset: 'core' },
			pluginData: {
				dir: storage.pluginDataDir,
			},
			http: {
				controlPlane: { web: true, rpc: true, sse: true },
				uiAssets: 'hmr-server',
			},
			extensionService: { enabled: true },
		},
	})
	installStaticRuntimeHmr({ host, viteServer })

	const startup = await host.start()
	host.ctx.logger.info('Static commercial runtime ready', {
		profile: activeProfile,
		startup: startup.entries.map(({ name, status }) => `${name}:${status}`),
	})

	return {
		fetch: async (request) => host.ctx.http.fetch(request),
		stop: () => host.stop(),
	}
}
