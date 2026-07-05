import type { EntryResolver } from './entry-resolver'
import { nodeWorkspaceFs, type WorkspaceFs } from './fs'
import { buildScanGraph } from './graph-builder'
import {
	normalizePackageDir,
	normalizePackageName,
	type PackageSelector,
	selectorKeys,
} from './selectors'
import type { EntryResolution, PackageNode, ResolvedScanOptions, ScanGraph } from './types'

export interface ScanSnapshot {
	graph: ScanGraph
	packages: PackageNode[]
	entries: string[]
	fallbackEntries: string[]
	byName: ReadonlyMap<string, PackageNode>
	byDir: ReadonlyMap<string, PackageNode>
	findPackage(selector: PackageSelector): PackageNode | undefined
	resolveEntry(selector: PackageSelector): EntryResolution | undefined
}

export async function buildScanSnapshot(
	inputs: string[],
	options: ResolvedScanOptions,
	entryResolver: EntryResolver,
	fs: WorkspaceFs = nodeWorkspaceFs,
): Promise<ScanSnapshot> {
	const graph = await buildScanGraph(inputs, options, entryResolver, fs)
	const index = indexPackages(graph.packages)

	const findPackage = (selector: PackageSelector) => selectPackage(selector, index)
	const resolveEntry = (selector: PackageSelector) => findPackage(selector)?.entry

	return {
		graph,
		packages: graph.packages,
		entries: graph.entries,
		fallbackEntries: graph.fallbackEntries,
		byName: index.byName,
		byDir: index.byDir,
		findPackage,
		resolveEntry,
	}
}

function indexPackages(packages: PackageNode[]) {
	const byName = new Map<string, PackageNode>()
	const byDir = new Map<string, PackageNode>()

	for (const pkg of packages) {
		const dirKey = normalizePackageDir(pkg.dir)
		if (dirKey && !byDir.has(dirKey)) byDir.set(dirKey, pkg)

		const nameKey = normalizePackageName(pkg.name)
		if (nameKey && !byName.has(nameKey)) byName.set(nameKey, pkg)
	}

	return { byName, byDir }
}

function selectPackage(
	selector: PackageSelector,
	index: ReturnType<typeof indexPackages>,
): PackageNode | undefined {
	const keys = selectorKeys(selector)
	if (keys.name) {
		const match = index.byName.get(keys.name)
		if (match) return match
	}
	if (keys.dir) {
		const match = index.byDir.get(keys.dir)
		if (match) return match
	}
	return undefined
}
