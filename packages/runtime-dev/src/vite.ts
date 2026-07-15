import { createServerModuleRunner, type ViteDevServer } from 'vite'
import type { ModuleRunner } from 'vite/module-runner'

const pluxelSsrModuleRunners = new WeakMap<ViteDevServer, ModuleRunner>()
const pluxelSsrModuleRunnerClosePatched = new WeakSet<ViteDevServer>()

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
