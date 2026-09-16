import { normalizePath, type EnvironmentModuleNode, type ViteDevServer } from 'vite'
import { invalidateHostModuleClassifiers } from './host-modules'
import { collectViteSsrImportFiles } from './runner'

export function invalidateHostChangedModules(options: {
	server: ViteDevServer
	changedFile: string
	applicationFiles: ReadonlySet<string>
	changedModules: readonly EnvironmentModuleNode[]
	recoverMissingImports: boolean
	/** A producer republished an entry; reload its previous ESM dependency closure too. */
	reloadDependencies?: boolean
}): Readonly<{ count: number; modules: ReadonlySet<string> }> {
	const { server, changedFile, applicationFiles, changedModules, recoverMissingImports } = options
	invalidateHostModuleClassifiers(server)
	type ModuleLike = {
		id?: string
		file?: string | null
		importers?: Set<ModuleLike>
	}

	const queue: ModuleLike[] = [...changedModules]
	const seen = new Set<ModuleLike>()
	// The watcher path is the direct update authority. Keep it alongside graph IDs/files because
	// Vite may index a package-root module through its symlink while semantic transforms use the
	// physical file (or vice versa).
	const modules = new Set<string>([normalizePath(changedFile)])
	const graph = server.environments.ssr.moduleGraph
	for (const mod of graph.getModulesByFile(changedFile) ?? []) {
		queue.push(mod as ModuleLike)
	}
	// A new producer entry has no graph node yet. Its absence must not evict unrelated
	// fixed plugins. Failed imports and ordinary application path misses still need
	// their importer closure retried.
	if ((queue.length === 0 && !options.reloadDependencies) || recoverMissingImports) {
		for (const file of applicationFiles) {
			for (const mod of graph.getModulesByFile(file) ?? []) {
				queue.push(mod as ModuleLike)
			}
		}
	}

	if (options.reloadDependencies) {
		for (const file of collectViteSsrImportFiles(server, changedFile)) {
			for (const mod of graph.getModulesByFile(file) ?? []) queue.push(mod as ModuleLike)
		}
	}

	let invalidated = 0
	while (queue.length > 0) {
		const mod = queue.shift()!
		if (seen.has(mod)) continue
		seen.add(mod)
		if (mod.id) modules.add(mod.id)
		if (mod.file) modules.add(normalizePath(mod.file))
		graph.invalidateModule(mod as Parameters<typeof graph.invalidateModule>[0])
		invalidated++
		for (const importer of mod.importers ?? []) queue.push(importer)
	}
	return { count: invalidated, modules }
}
