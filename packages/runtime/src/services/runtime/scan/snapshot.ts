import type { EntryResolver } from './entry-resolver'
import { nodeWorkspaceFs, type WorkspaceFs } from './fs'
import { buildScanGraph } from './graph-builder'
import {
	normalizePackageDir,
	normalizePackageName,
	type PackageSelector,
	selectorKeys,
} from './selectors'
import { createScanCacheKey } from './shared'
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

export class ScanSnapshotBuilder {
	constructor(
		private readonly entryResolver: EntryResolver,
		private readonly fs: WorkspaceFs = nodeWorkspaceFs,
	) {}

	async build(inputs: string[], options: ResolvedScanOptions): Promise<ScanSnapshot> {
		const graph = await buildScanGraph(inputs, options, this.entryResolver, this.fs)
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
}

export class ScanSnapshotCache {
	private readonly cache = new Map<string, Promise<ScanSnapshot>>()

	constructor(private readonly builder: ScanSnapshotBuilder) {}

	get(inputs: string[], options: ResolvedScanOptions): Promise<ScanSnapshot> {
		const key = createScanCacheKey(inputs, options)
		const cached = this.cache.get(key)
		if (cached) return cached

		const promise = this.builder.build(inputs, options).catch((err) => {
			this.cache.delete(key)
			throw err
		})
		this.cache.set(key, promise)
		return promise
	}

	clear() {
		this.cache.clear()
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
