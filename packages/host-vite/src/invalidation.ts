import { normalizePath, type EnvironmentModuleNode, type ViteDevServer } from 'vite'
import type { EvaluatedModuleNode } from 'vite/module-runner'
import {
	getHostModuleRunner,
	invalidateHostModuleClassifiers,
	HOST_VITE_ENVIRONMENT,
} from './environment'

export function invalidateHostChangedModules(options: {
	server: ViteDevServer
	changes: readonly Readonly<{ file: string; reloadDependencies: boolean }>[]
	applicationFiles: ReadonlySet<string>
	recoverMissingImports: boolean
	/** Only old dependencies whose evaluated bytes changed may be evicted. */
	changedDependencies?: readonly string[]
}): void {
	const { server, changes, applicationFiles, recoverMissingImports } = options
	invalidateHostModuleClassifiers(server)
	const queue: EnvironmentModuleNode[] = []
	const seen = new Set<EnvironmentModuleNode>()
	const invalidatedGraph = new Set<EnvironmentModuleNode>()
	// The watcher path is the direct update authority. Keep it alongside graph IDs/files because
	// Vite may index a package-root module through its symlink while semantic transforms use the
	// physical file (or vice versa).
	const modules = new Set<string>(changes.map(({ file }) => normalizePath(file)))
	const graph = server.environments[HOST_VITE_ENVIRONMENT].moduleGraph
	let retryApplication = recoverMissingImports
	for (const change of changes) {
		const changed = graph.getModulesByFile(change.file)
		if (!changed?.size && !change.reloadDependencies) retryApplication = true
		for (const mod of changed ?? []) queue.push(mod)
	}
	// New producer entries don't evict unrelated fixed plugins; unresolved imports do.
	if (retryApplication) {
		for (const file of applicationFiles) {
			modules.add(file)
			for (const mod of graph.getModulesByFile(file) ?? []) queue.push(mod)
		}
	}
	for (const file of options.changedDependencies ?? []) {
		modules.add(file)
		for (const mod of graph.getModulesByFile(file) ?? []) queue.push(mod)
	}

	for (let index = 0; index < queue.length; index++) {
		const mod = queue[index]!
		if (seen.has(mod)) continue
		seen.add(mod)
		if (mod.id) modules.add(mod.id)
		if (mod.file) modules.add(normalizePath(mod.file))
		graph.invalidateModule(mod, invalidatedGraph)
		for (const importer of mod.importers ?? []) queue.push(importer)
	}
	// Invalidate the evaluated namespace once per batch, including console importers.
	const runner = getHostModuleRunner(server)
	const evaluated: EvaluatedModuleNode[] = []
	for (const file of modules) {
		for (const module of runner.evaluatedModules.getModulesByFile(file) ?? [])
			evaluated.push(module)
	}
	const visited = new Set<string>()
	for (let index = 0; index < evaluated.length; index++) {
		const current = evaluated[index]!
		if (visited.has(current.id)) continue
		visited.add(current.id)
		for (const importer of current.importers) {
			const module = runner.evaluatedModules.getModuleById(importer)
			if (module) evaluated.push(module)
		}
		runner.evaluatedModules.invalidateModule(current)
	}
}
