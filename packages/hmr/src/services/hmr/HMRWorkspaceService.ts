import { type Context, Injectable } from '@pluxel/core'
import { EntryResolver } from '../market/scan/entry-resolver'
import { buildScanGraph } from '../market/scan/graph-builder'
import { DEFAULT_SCAN_OPTIONS, resolveScanOptions } from '../market/scan/options'
import { ModuleResolveCache } from '../market/scan/resolve-cache'
import {
	type ResolvedScanOptions,
	type ScanGraph,
	type ScanOptionsInput,
} from '../market/scan/types'
import { normalizeScanInputs, resolveScanRoots } from '../market/scan/shared'

const serviceName = 'hmrWorkspaceService' as const

declare module '@pluxel/core' {
	interface Context {
		[serviceName]: HMRWorkspaceService
	}
	interface Config {
		[serviceName]?: HMRWorkspaceServiceConfig
	}
}

export interface HMRWorkspaceServiceConfig {
	roots?: string | string[]
	scan?: ScanOptionsInput
}

export interface WorkspaceScanTask {
	roots?: string | string[]
	scan?: ScanOptionsInput
}

export interface WorkspaceScanSnapshot {
	graph: ScanGraph
	entries: string[]
	fallbackEntries: string[]
	files: string[]
}

const BASE_HMR_SCAN_OPTIONS = resolveScanOptions(DEFAULT_SCAN_OPTIONS, {
	conditions: ['@pluxel/hmr', '@pluxel/source', 'import', 'module', 'default'],
	preferHmrExports: true,
	fallbackTsOnSingle: true,
})

@Injectable({ key: serviceName })
export class HMRWorkspaceService {
	private defaults: ResolvedScanOptions
	private roots: string[]
	private readonly resolveCache = new ModuleResolveCache()
	private readonly entryResolver = new EntryResolver(this.resolveCache)

	constructor(_ctx: Context, config: HMRWorkspaceServiceConfig = {}) {
		this.defaults = resolveScanOptions(BASE_HMR_SCAN_OPTIONS, config.scan)
		this.roots = normalizeScanInputs(config.roots ?? process.cwd())
	}

	get defaultRoots(): string[] {
		return [...this.roots]
	}

	updateConfig(config: HMRWorkspaceServiceConfig = {}) {
		let mutated = false
		if (config.scan) {
			this.defaults = resolveScanOptions(this.defaults, config.scan)
			mutated = true
		}
		if (config.roots) {
			this.roots = normalizeScanInputs(config.roots)
			mutated = true
		}
		if (mutated) this.clearCaches()
	}

	setRoots(roots: string | string[]) {
		this.roots = normalizeScanInputs(roots)
		this.clearCaches()
	}

	setDefaultOptions(overrides: ScanOptionsInput) {
		this.updateConfig({ scan: overrides })
	}

	clearCaches() {
		this.invalidateResolverCache()
	}

	invalidateResolverCache() {
		this.entryResolver.clear()
		this.resolveCache.clear()
	}

	async scanEntries(request: WorkspaceScanTask = {}): Promise<string[]> {
		const snapshot = await this.snapshot(request)
		return snapshot.files
	}

	async scanGraph(request: WorkspaceScanTask = {}): Promise<ScanGraph> {
		const snapshot = await this.snapshot(request)
		return snapshot.graph
	}

	async snapshot(request: WorkspaceScanTask = {}): Promise<WorkspaceScanSnapshot> {
		const roots = resolveScanRoots(this.roots, request.roots)
		const options = resolveScanOptions(this.defaults, request.scan)
		return this.buildSnapshot(roots, options)
	}

	private async buildSnapshot(
		roots: string[],
		options: ResolvedScanOptions,
	): Promise<WorkspaceScanSnapshot> {
		const graph = await buildScanGraph(roots, options, this.entryResolver)
		const files = new Set<string>()
		for (const entry of graph.entries) files.add(entry)
		for (const fallback of graph.fallbackEntries) files.add(fallback)
		return {
			graph,
			entries: graph.entries,
			fallbackEntries: graph.fallbackEntries,
			files: Array.from(files),
		}
	}
}
