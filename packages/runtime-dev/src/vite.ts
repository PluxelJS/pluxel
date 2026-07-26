import { createServerModuleRunner, normalizePath, type UserConfig, type ViteDevServer } from 'vite'
import type { ModuleRunner } from 'vite/module-runner'

const pluxelSsrModuleRunners = new WeakMap<ViteDevServer, ModuleRunner>()
const pluxelSsrModuleRunnerClosePatched = new WeakSet<ViteDevServer>()

const WORKBENCH_CLIENT_OPTIMIZE_DEPS = [
	'@tabler/icons-react',
	'@pluxel/runtime > @elysiajs/eden',
	'@pluxel/runtime > capnweb',
] as const

export type ImportViteSsrModuleOptions = {
	/**
	 * Clears the Pluxel SSR runner cache before import. Use this for config modules
	 * reloaded from Vite HMR, where stale evaluated exports are more harmful than
	 * re-running the small config graph.
	 */
	fresh?: boolean
}

export async function importViteSsrModule<T = Record<string, unknown>>(
	server: ViteDevServer,
	id: string,
	options: ImportViteSsrModuleOptions = {},
): Promise<T> {
	const runner = getPluxelViteSsrModuleRunner(server)
	if (options.fresh) runner.clearCache()
	return runner.import<T>(id)
}

export function invalidateViteSsrModule(server: ViteDevServer, file: string): number {
	const runner = getPluxelViteSsrModuleRunner(server)
	const queue = [...(runner.evaluatedModules.getModulesByFile(file) ?? [])]
	const seen = new Set<string>()
	let invalidated = 0
	while (queue.length > 0) {
		const current = queue.shift()!
		if (seen.has(current.id)) continue
		seen.add(current.id)
		for (const importer of current.importers) {
			const importerModule = runner.evaluatedModules.getModuleById(importer)
			if (importerModule) queue.push(importerModule)
		}
		runner.evaluatedModules.invalidateModule(current)
		invalidated++
	}
	return invalidated
}

type ViteSsrModuleGraphEntry = {
	file?: string | null
	importedModules?: Set<ViteSsrModuleGraphEntry>
}

export function collectViteSsrImportFiles(server: ViteDevServer, entry: string): Set<string> {
	const files = new Set<string>([normalizePath(entry)])
	const queue = [...(server.moduleGraph.getModulesByFile(entry) ?? [])] as ViteSsrModuleGraphEntry[]

	while (queue.length > 0) {
		const module = queue.shift()!
		if (module.file) files.add(normalizePath(module.file))
		for (const imported of module.importedModules ?? []) {
			if (imported.file && !files.has(normalizePath(imported.file))) queue.push(imported)
		}
	}
	return files
}

export function invalidateViteModuleGraphFiles(
	server: ViteDevServer,
	files: Iterable<string>,
): number {
	let invalidated = 0
	for (const file of files) {
		for (const module of server.moduleGraph.getModulesByFile(file) ?? []) {
			server.moduleGraph.invalidateModule(module)
			invalidated++
		}
	}
	return invalidated
}

/**
 * Declares the Workbench browser graph before Vite creates its dependency optimizer.
 *
 * This must be returned from a plugin `config` hook. Mutating the resolved client environment from
 * `configureServer` races Vite's initial scan and can leave an incremental optimizer batch without
 * metadata for dependencies from the previous batch.
 */
export function createWorkbenchViteClientConfig(clientEntryUrl: string): UserConfig {
	const entry = clientEntryUrl.startsWith('/@fs/')
		? clientEntryUrl.slice('/@fs'.length)
		: clientEntryUrl
	return {
		optimizeDeps: {
			entries: [entry],
			include: [...WORKBENCH_CLIENT_OPTIMIZE_DEPS],
			noDiscovery: false,
			holdUntilCrawlEnd: true,
			ignoreOutdatedRequests: true,
		},
	}
}

function getPluxelViteSsrModuleRunner(server: ViteDevServer): ModuleRunner {
	const existing = pluxelSsrModuleRunners.get(server)
	if (existing && !existing.isClosed()) return existing

	const environment = server.environments.ssr
	// Prefer Vite 8's Environment Module Runner over server.ssrLoadModule.
	// The compat loader disables sourcemap interception, while the runner keeps
	// source locations correct for diagnostics such as logger caller capture.
	const runner = createServerModuleRunner(environment, {
		hmr: false,
		sourcemapInterceptor: 'prepareStackTrace',
	})
	pluxelSsrModuleRunners.set(server, runner)
	if (!pluxelSsrModuleRunnerClosePatched.has(server)) {
		pluxelSsrModuleRunnerClosePatched.add(server)
		const close = server.close.bind(server)
		server.close = async () => {
			const current = pluxelSsrModuleRunners.get(server)
			pluxelSsrModuleRunners.delete(server)
			if (current && !current.isClosed()) await current.close()
			await close()
		}
	}
	return runner
}
