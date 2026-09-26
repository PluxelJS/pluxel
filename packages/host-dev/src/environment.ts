import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { clearOxcResolutionCache } from '@pluxel/rolldown/resolver/oxc'
import {
	createRunnableDevEnvironment,
	normalizePath,
	type DevEnvironment,
	type Plugin,
	type ResolvedConfig,
	type RunnableDevEnvironment,
	type ViteDevServer,
} from 'vite'
import type { ModuleRunner } from 'vite/module-runner'
import { createHostModuleClassifier } from './host-modules'

export const HOST_VITE_ENVIRONMENT = 'pluxel'

type HostEnvironmentState = {
	classifier: ReturnType<typeof createHostModuleClassifier>
	singletonFiles: Set<string>
	nativeFiles: Set<string>
}

const environments = new WeakMap<DevEnvironment, HostEnvironmentState>()

/** Own the Node SSR environment, including its runner and native module policy. */
export function hostEnvironment(): Plugin {
	return {
		name: 'pluxel:host-environment',
		apply: 'serve',
		config(config) {
			if (config.environments?.[HOST_VITE_ENVIRONMENT]?.dev?.createEnvironment) {
				throw new TypeError(
					'[host-dev/vite] The pluxel environment is owned by host(); remove its custom createEnvironment factory',
				)
			}
			return {
				environments: {
					[HOST_VITE_ENVIRONMENT]: {
						consumer: 'server',
						dev: { createEnvironment: createHostEnvironment },
					},
				},
			}
		},
		configResolved(config) {
			if (
				config.environments[HOST_VITE_ENVIRONMENT].dev.createEnvironment !== createHostEnvironment
			) {
				throw new TypeError(
					'[host-dev/vite] Another plugin replaced the Host pluxel environment factory',
				)
			}
		},
	}
}

function createHostEnvironment(name: string, config: ResolvedConfig): RunnableDevEnvironment {
	const environment = createRunnableDevEnvironment(name, config, {
		runnerOptions: { hmr: false, sourcemapInterceptor: 'prepareStackTrace' },
	})
	const state: HostEnvironmentState = {
		classifier: createHostModuleClassifier(),
		singletonFiles: new Set(),
		nativeFiles: new Set(),
	}
	environments.set(environment, state)
	const fetchModule = environment.fetchModule.bind(environment)
	// Vite exposes a runnable factory, but its class constructor is type-only.
	// Assemble the policy here before Vite initializes or exposes the environment.
	environment.fetchModule = async (id, importer, options) => {
		const resolved = await environment.pluginContainer.resolveId(id, importer)
		if (resolved && isAbsolute(resolved.id)) {
			const file = normalizePath(resolved.id.split(/[?#]/, 1)[0]!)
			const decision = state.singletonFiles.has(file)
				? null
				: await state.classifier.classifyFile(file)
			if (state.singletonFiles.has(file) || decision) {
				state.nativeFiles.add(file)
				return { externalize: pathToFileURL(file).href, type: decision?.format ?? 'module' }
			}
		}
		return fetchModule(id, importer, options)
	}
	return environment
}

function getHostEnvironmentState(environment: DevEnvironment): HostEnvironmentState {
	const state = environments.get(environment)
	if (!state)
		throw new TypeError('[host-dev/vite] This operation requires the Host pluxel environment')
	return state
}

export function registerHostSingleton(environment: DevEnvironment, file: string): void {
	getHostEnvironmentState(environment).singletonFiles.add(normalizePath(file))
}

export function invalidateHostModuleClassifiers(server: ViteDevServer): void {
	clearOxcResolutionCache()
	// Vite caches package manifests independently of its module graph.
	const packageCache = (server.config as unknown as { packageCache?: Map<string, unknown> })
		.packageCache
	packageCache?.clear()
	getHostEnvironmentState(server.environments[HOST_VITE_ENVIRONMENT]).classifier.clear()
}

/** Vite owns this environment's single runner and closes it after plugin cleanup. */
export function getHostModuleRunner(server: ViteDevServer): ModuleRunner {
	const environment = server.environments[HOST_VITE_ENVIRONMENT]
	getHostEnvironmentState(environment)
	return (environment as RunnableDevEnvironment).runner
}

export type ImportHostModuleOptions = {
	/**
	 * Clears the Pluxel SSR runner cache before import. Use this for config modules
	 * reloaded from Vite HMR, where stale evaluated exports are more harmful than
	 * re-running the small config graph.
	 */
	fresh?: boolean
}

export async function importHostModule<T = Record<string, unknown>>(
	server: ViteDevServer,
	id: string,
	options: ImportHostModuleOptions = {},
): Promise<T> {
	const runner = getHostModuleRunner(server)
	if (options.fresh) runner.clearCache()
	return runner.import<T>(id)
}

export function invalidateHostModule(server: ViteDevServer, file: string): number {
	const runner = getHostModuleRunner(server)
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

export function collectHostImportFiles(server: ViteDevServer, entry: string): Set<string> {
	const files = new Set<string>([normalizePath(entry)])
	const queue = [
		...(server.environments[HOST_VITE_ENVIRONMENT].moduleGraph.getModulesByFile(entry) ?? []),
	] as ViteSsrModuleGraphEntry[]

	while (queue.length > 0) {
		const module = queue.shift()!
		// Native imports are shared process identities, outside this runner's reload
		// closure. Traversing Core here would invalidate every unrelated plugin.
		if (
			module.file &&
			getHostEnvironmentState(server.environments[HOST_VITE_ENVIRONMENT]).nativeFiles.has(
				normalizePath(module.file),
			)
		)
			continue
		if (module.file) files.add(normalizePath(module.file))
		for (const imported of module.importedModules ?? []) {
			if (imported.file && !files.has(normalizePath(imported.file))) queue.push(imported)
		}
	}
	return files
}

export function invalidateHostModuleGraphFiles(
	server: ViteDevServer,
	files: Iterable<string>,
): number {
	const graph = server.environments[HOST_VITE_ENVIRONMENT].moduleGraph
	let invalidated = 0
	for (const file of files) {
		for (const module of graph.getModulesByFile(file) ?? []) {
			graph.invalidateModule(module)
			invalidated++
		}
	}
	return invalidated
}
