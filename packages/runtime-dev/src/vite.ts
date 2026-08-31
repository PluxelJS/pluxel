import { createServerModuleRunner, normalizePath, type UserConfig, type ViteDevServer } from 'vite'
import type { ModuleRunner } from 'vite/module-runner'

export {
	createHostModuleClassifier,
	createHostModuleVitePlugin,
	type HostModuleClassifier,
	type HostModuleDecision,
} from './host-modules.ts'
export {
	attachSrvxViteNodeCarrier,
	createViteNodeElysiaApplicationCarrier,
	type SrvxViteNodeCarrierAttachment,
	type SrvxViteNodeCarrierOptions,
	type ViteBusinessWebSocketUpgrade,
	type ViteNodeElysiaApplicationCarrierOptions,
} from './vite-node-carrier.ts'

const PLUXEL_SSR_MODULE_RUNNER_STATE = Symbol.for('pluxel.viteSsrModuleRunnerState')
const PLUXEL_SSR_MODULE_RUNNER_EXTERNALIZER = Symbol.for('pluxel.viteSsrModuleRunnerExternalizer')

type ViteSsrModuleRunnerState = {
	runner?: ModuleRunner
	closePatched: boolean
	externalModules: Set<ViteSsrExternalModuleRegistration>
}

type ViteSsrExternalModuleRegistration = {
	modules: ReadonlyMap<string, string>
}

const WORKBENCH_CLIENT_OPTIMIZE_DEPS = ['@tabler/icons-react', '@pluxel/runtime > capnweb'] as const

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
	const queue = [
		...(server.environments.ssr.moduleGraph.getModulesByFile(entry) ?? []),
	] as ViteSsrModuleGraphEntry[]

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
	const graph = server.environments.ssr.moduleGraph
	let invalidated = 0
	for (const file of files) {
		for (const module of graph.getModulesByFile(file) ?? []) {
			graph.invalidateModule(module)
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

/** Returns the single Pluxel-owned SSR runner/evaluated namespace for a Vite server. */
export function getPluxelViteSsrModuleRunner(server: ViteDevServer): ModuleRunner {
	const state = getViteSsrModuleRunnerState(server)
	const existing = state.runner
	if (existing && !existing.isClosed()) return existing

	const environment = server.environments.ssr
	// Prefer Vite 8's Environment Module Runner over server.ssrLoadModule.
	// The compat loader disables sourcemap interception, while the runner keeps
	// source locations correct for diagnostics such as logger caller capture.
	const runner = createServerModuleRunner(environment, {
		hmr: false,
		sourcemapInterceptor: 'prepareStackTrace',
	})
	state.runner = runner
	installViteSsrModuleExternalizer(runner, state.externalModules)
	if (!state.closePatched) {
		state.closePatched = true
		const close = server.close.bind(server)
		server.close = async () => {
			const current = state.runner
			state.runner = undefined
			try {
				await close()
			} finally {
				if (current && !current.isClosed()) await current.close()
			}
		}
	}
	return runner
}

/**
 * Preserves native ESM identity for exact SSR request URL → canonical URL mappings.
 * The map only handles second-stage ModuleRunner fetches; normal Vite resolution remains in charge
 * of selecting and authorizing the entries placed in it. The returned unregister function is
 * idempotent and does not close the server-owned runner.
 */
export function registerViteSsrExternalModuleUrls(
	server: ViteDevServer,
	modules: ReadonlyMap<string, string>,
): () => void {
	const state = getViteSsrModuleRunnerState(server)
	const registration = { modules }
	state.externalModules.add(registration)
	getPluxelViteSsrModuleRunner(server)
	return () => {
		state.externalModules.delete(registration)
	}
}

function getViteSsrModuleRunnerState(server: ViteDevServer): ViteSsrModuleRunnerState {
	const record = server as unknown as Record<PropertyKey, unknown>
	const existing = record[PLUXEL_SSR_MODULE_RUNNER_STATE] as ViteSsrModuleRunnerState | undefined
	if (existing) return existing
	const state: ViteSsrModuleRunnerState = {
		closePatched: false,
		externalModules: new Set(),
	}
	record[PLUXEL_SSR_MODULE_RUNNER_STATE] = state
	return state
}

function installViteSsrModuleExternalizer(
	runner: ModuleRunner,
	externalModules: ReadonlySet<ViteSsrExternalModuleRegistration>,
): void {
	const transport = (runner as unknown as { transport?: unknown }).transport
	if (!transport || typeof transport !== 'object') {
		throw new TypeError('[runtime-dev/vite] Vite SSR ModuleRunner transport is unavailable')
	}
	const record = transport as Record<PropertyKey, unknown>
	if (record[PLUXEL_SSR_MODULE_RUNNER_EXTERNALIZER]) return
	const invoke = record.invoke
	if (typeof invoke !== 'function') {
		throw new TypeError('[runtime-dev/vite] Vite SSR ModuleRunner transport cannot be invoked')
	}
	const originalInvoke = (invoke as (name: string, data: unknown) => Promise<unknown>).bind(
		transport,
	)
	record[PLUXEL_SSR_MODULE_RUNNER_EXTERNALIZER] = true
	record.invoke = (name: string, data: unknown) => {
		if (name === 'fetchModule' && Array.isArray(data) && typeof data[0] === 'string') {
			for (const registration of externalModules) {
				const canonicalUrl = registration.modules.get(data[0])
				if (canonicalUrl) {
					return Promise.resolve({ externalize: canonicalUrl, type: 'module' })
				}
			}
		}
		return originalInvoke(name, data)
	}
}
