import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Logger as LogtapeLogger } from '@logtape/logtape'
import type { Context } from '@pluxel/core'
import { glob } from 'tinyglobby'
import { type DevEnvironment, type EnvironmentModuleNode as ModuleNode, normalizePath } from 'vite'
import type { ScanService } from '../market/ScanService'
import type { HmrPathApi, HmrToolkit } from './environment'
import { startTimer } from './internals'
import { collectHotspots, isLogEnabled, logAttributionReport, type TimingTracker } from './logging'
import { collectPluginTotals } from './operational-report'
import type { HmrRunner } from './runner'
import { runWithRequireShims } from './runtime-shims'

export type PrefetchOrder = 'near' | 'all'

function dedupeCleanIds(ids: readonly string[], toClean: (id: string) => string) {
	const seen = new Set<string>()
	const out: string[] = []
	for (let i = 0; i < ids.length; i++) {
		const id = toClean(ids[i]!)
		if (seen.has(id)) continue
		seen.add(id)
		out.push(id)
	}
	return out
}

function dedupeIds(ids: readonly string[]) {
	const seen = new Set<string>()
	const out: string[] = []
	for (let i = 0; i < ids.length; i++) {
		const id = ids[i]!
		if (seen.has(id)) continue
		seen.add(id)
		out.push(id)
	}
	return out
}

export async function collectColdStartEntries(params: {
	rootsAbs: readonly string[]
	/** Must be clean ids (output of HMRService.getAnchorsCleanSnapshot). */
	anchors: ReadonlySet<string>
	path: HmrPathApi
	/** Optional fast filter for non-anchor entries (clean ids). */
	pathFilter?: (cleanId: string) => boolean
	scanService?: ScanService
	workspaceConditions: readonly string[]
}) {
	const entries = new Set<string>()
	for (const anchor of params.anchors) entries.add(anchor)
	const pathFilter = params.pathFilter

	const rootInfos = params.rootsAbs.map((raw) => ({ raw, normalized: normalizePath(raw) }))
	const workspace = await tryCollectWorkspaceEntries({
		rootInfos,
		path: params.path,
		pathFilter,
		scanService: params.scanService,
		workspaceConditions: params.workspaceConditions,
	})
	if (workspace) for (const entry of workspace.entries) entries.add(entry)

	const covered = workspace?.covered
	const uncovered = covered
		? rootInfos.filter((info) => !covered.has(info.normalized)).map((info) => info.raw)
		: rootInfos.map((info) => info.raw)

	if (uncovered.length) {
		const fallbackEntries = await collectDirectoryFallbackEntries(
			uncovered,
			params.path,
			pathFilter,
		)
		for (const entry of fallbackEntries) entries.add(entry)
	}

	return [...entries]
}

async function tryCollectWorkspaceEntries(params: {
	rootInfos: Array<{ raw: string; normalized: string }>
	path: HmrPathApi
	pathFilter?: (cleanId: string) => boolean
	scanService?: ScanService
	workspaceConditions: readonly string[]
}) {
	if (!params.scanService) return null
	const roots = params.rootInfos.map((info) => info.raw)
	try {
		const workspaceEntries = await params.scanService.listWorkspaceEntries({
			roots,
			workspaceOnly: true,
			scan: {
				preferHmrExports: true,
				conditions: params.workspaceConditions as unknown as string[],
			},
		})

		const covered = new Set<string>()
		const entries: string[] = []
		const shouldInclude = params.pathFilter
		for (const pkg of workspaceEntries) {
			const clean = params.path.toClean(pkg.entry)
			if (!shouldInclude || shouldInclude(clean)) entries.push(clean)
			const dirNorm = normalizePath(pkg.dir)
			for (const info of params.rootInfos) {
				if (!covered.has(info.normalized) && dirNorm.startsWith(info.normalized)) {
					covered.add(info.normalized)
					break
				}
			}
		}

		return { entries, covered }
	} catch {
		return null
	}
}

async function collectDirectoryFallbackEntries(
	roots: readonly string[],
	path: HmrPathApi,
	pathFilter?: (cleanId: string) => boolean,
) {
	const patterns = roots.flatMap((root) => [`${root}/**/*.ts`])
	const files = await glob(patterns, {
		absolute: true,
		onlyFiles: true,
		ignore: ['**/*.d.ts', '**/node_modules/**'],
	})
	const seen = new Set<string>()
	const out: string[] = []
	const toClean = path.toClean
	const shouldInclude = pathFilter
	for (let i = 0; i < files.length; i++) {
		const clean = toClean(files[i]!)
		if (shouldInclude && !shouldInclude(clean)) continue
		if (seen.has(clean)) continue
		seen.add(clean)
		out.push(clean)
	}
	return out
}

type BatchGraph = {
	affectedIds: Set<string>
	roots: string[]
	distance: Map<string, number>
}

type ScopeFilter = (cleanId: string) => boolean

class GraphTools {
	private readonly visited = new Set<string>()
	private readonly affectedIds = new Set<string>()
	private readonly idToNode = new Map<string, ModuleNode>()
	private readonly distance = new Map<string, number>()
	private readonly roots: string[] = []
	private readonly queue: ModuleNode[] = []
	private readonly queueDist: number[] = []
	private readonly tmpModules: ModuleNode[] = []
	private readonly moduleGraph: DevEnvironment['moduleGraph']
	private readonly toClean: (id: string) => string
	private readonly variantsAny: (id: string) => string[]
	private readonly variantsClean: (id: string) => string[]

	constructor(
		private readonly env: DevEnvironment,
		private readonly path: HmrPathApi,
		private readonly inScope: ScopeFilter,
	) {
		this.moduleGraph = env.moduleGraph
		this.toClean = path.toClean
		this.variantsAny = path.variants
		this.variantsClean = path.variantsClean ?? path.variants
	}

	collectModulesByFile(fileOrId: string, out: ModuleNode[]): number {
		out.length = 0
		const first = fileOrId.charCodeAt(0)
		const variants =
			first === 47 || first === 0
				? this.variantsClean(fileOrId)
				: this.variantsAny(fileOrId)
		const moduleGraph = this.moduleGraph
		for (const variant of variants) {
			const byFile = moduleGraph.getModulesByFile(variant)
			if (byFile?.size) {
				for (const m of byFile) out.push(m)
				return out.length
			}
			const single = moduleGraph.getModuleById(variant)
			if (single) {
				out.push(single)
				return 1
			}
		}
		return 0
	}

	collectBatchGraph(files: readonly string[]): BatchGraph {
		this.visited.clear()
		this.affectedIds.clear()
		this.idToNode.clear()
		this.distance.clear()
		this.roots.length = 0
		this.queue.length = 0
		this.queueDist.length = 0

		const visited = this.visited
		const affectedIds = this.affectedIds
		const idToNode = this.idToNode
		const distance = this.distance
		const toClean = this.toClean
		const inScope = this.inScope

		const queue = this.queue
		const queueDist = this.queueDist
		const tmpModules = this.tmpModules

		for (const file of files) {
			const modCount = this.collectModulesByFile(file, tmpModules)
			for (let i = 0; i < modCount; i++) {
				const m = tmpModules[i]!
				queue.push(m)
				queueDist.push(0)
			}

			const clean = file
			if (modCount === 0 && inScope(clean) && !visited.has(clean)) {
				visited.add(clean)
				affectedIds.add(clean)
				distance.set(clean, 0)
			}
		}

		for (let cursor = 0; cursor < queue.length; cursor++) {
			const m = queue[cursor]
			if (!m || !m.id) continue
			const d = queueDist[cursor] ?? 0

			const id = toClean(m.id)
			if (id.startsWith('\0')) continue
			if (!inScope(id)) continue
			if (visited.has(id)) continue

			visited.add(id)
			affectedIds.add(id)
			idToNode.set(id, m)
			distance.set(id, d)

			for (const importer of m.importers) {
				if (!importer || !importer.id) continue
				queue.push(importer)
				queueDist.push(d + 1)
			}
		}

		const roots = this.roots
		for (const id of affectedIds) {
			const m = idToNode.get(id)
			if (!m) {
				roots.push(id)
				continue
			}
			let hasImporterInside = false
			for (const importer of m.importers) {
				if (!importer || !importer.id) continue
				const importerId = toClean(importer.id)
				if (affectedIds.has(importerId)) {
					hasImporterInside = true
					break
				}
			}
			if (!hasImporterInside) roots.push(id)
		}

		return { affectedIds, roots, distance }
	}
}

class NearestAnchorFinder {
	private readonly cache = new Map<string, string | null>()
	private readonly visited = new Set<string>()
	private readonly queue: ModuleNode[] = []
	private readonly tmpModules: ModuleNode[] = []

	constructor(
		private readonly graph: GraphTools,
		private readonly path: HmrPathApi,
	) {}

	clear() {
		this.cache.clear()
	}

	find(startCleanId: string, anchors: ReadonlySet<string>): string | null {
		const cached = this.cache.get(startCleanId)
		if (cached !== undefined) return cached

		this.visited.clear()
		this.queue.length = 0
		const modCount = this.graph.collectModulesByFile(startCleanId, this.tmpModules)
		for (let i = 0; i < modCount; i++) this.queue.push(this.tmpModules[i]!)
		const visited = this.visited
		const queue = this.queue
		const toClean = this.path.toClean

		for (let cursor = 0; cursor < queue.length; cursor++) {
			const m = queue[cursor]
			if (!m || !m.id) continue
			const id = toClean(m.id)
			if (visited.has(id)) continue
			visited.add(id)

			if (id.startsWith('\0') || id.includes('/node_modules/')) continue

			if (anchors.has(id)) {
				this.cache.set(startCleanId, id)
				return id
			}

			for (const importer of m.importers) {
				if (!importer || !importer.id) continue
				queue.push(importer)
			}
		}

		this.cache.set(startCleanId, null)
		return null
	}
}

function pickTargetsByAnchors(params: {
	affectedIds: ReadonlySet<string>
	fallbackRoots: readonly string[]
	anchors: ReadonlySet<string>
	toClean: (id: string) => string
	findNearestAnchor: (startCleanId: string, anchors: ReadonlySet<string>) => string | null
}): Set<string> {
	if (params.anchors.size === 0) {
		const targets = new Set<string>()
		for (const r of params.fallbackRoots) targets.add(params.toClean(r))
		return targets
	}

	const targets = new Set<string>()
	let needFallbackRoots = false

	for (const id of params.affectedIds) {
		if (params.anchors.has(id)) {
			targets.add(id)
			continue
		}
		const anchor = params.findNearestAnchor(id, params.anchors)
		if (anchor) targets.add(anchor)
		else needFallbackRoots = true
	}

	if (needFallbackRoots) {
		for (const r of params.fallbackRoots) targets.add(params.toClean(r))
	}

	return targets
}

function buildOrderedList(
	base: ReadonlySet<string>,
	distance: ReadonlyMap<string, number>,
	order: PrefetchOrder,
	limit: number,
) {
	const items = [...base]
	if (order === 'near') {
		items.sort((a, b) => {
			const da = distance.get(a) ?? 1e9
			const db = distance.get(b) ?? 1e9
			return da - db || a.localeCompare(b)
		})
	} else {
		items.sort()
	}
	return items.slice(0, Math.max(1, limit))
}

export async function prefetchTransforms(params: {
	env: DevEnvironment
	ids: Iterable<string>
	timing: TimingTracker
	concurrency: number
}) {
	const seen = new Set<string>()
	const queue: string[] = []

	for (const raw of params.ids) {
		const id = raw
		if (seen.has(id)) continue
		seen.add(id)
		queue.push(id)
	}
	if (!queue.length) return

	let cursor = 0
	const workerCount = Math.min(params.concurrency, queue.length)

	const worker = async () => {
		while (true) {
			const index = cursor++
			if (index >= queue.length) break
			const id = queue[index]
			const end = params.timing.start('transform', id)
			try {
				await params.env.fetchModule(id)
			} catch {
				// Ignore transform errors (non-code resources, edge cases).
			}
			end()
		}
	}

	await Promise.all(Array.from({ length: workerCount }, () => worker()))
}

export type HmrExecutorConfig = {
	useRequireShims: boolean
	dbgModules: LogtapeLogger | null
}

export class HmrExecutor {
	constructor(
		private readonly ctx: Context,
		private readonly runner: HmrRunner,
		private readonly path: HmrPathApi,
		private readonly timing: TimingTracker,
		private readonly cfg: HmrExecutorConfig,
	) {}

	async runAndLoadAllClean(cleanIds: readonly string[], _keepOrder = true) {
		if (!cleanIds.length) return undefined

		// Historically `keepOrder=false` did not change ordering; preserve that behavior.
		const ordered = dedupeIds(cleanIds)

		const batch = this.ctx.loader.beginBatch()
		const dbg = this.cfg.dbgModules
		const debugModules = dbg ? isLogEnabled(dbg, 'debug') : false

		for (let i = 0; i < ordered.length; i++) {
			const id = ordered[i]!
			const endEvaluate = this.timing.start('evaluate', id)
			let mod: unknown
			try {
				const evaluate = () => this.runner.import(id)
				mod = this.cfg.useRequireShims ? await runWithRequireShims(evaluate) : await evaluate()
			} catch (err) {
				const cjsHint = buildCjsExternalizeHint(err)
				if (cjsHint) {
					this.ctx.logger.error('execute failed for {file}', { file: id, error: err })
					throw new Error(cjsHint, { cause: err })
				}
				this.ctx.logger.error('execute failed for {file}', { file: id, error: err })
				continue
			}
			const evaluateMs = endEvaluate()

			const endInject = this.timing.start('inject', id)
			let hasPlugin = false
			try {
				hasPlugin = await batch.replaceModule(id, mod)
			} catch (err) {
				this.ctx.logger.error('replaceModule failed for {file}', { file: id, error: err })
				batch.rollback()
				this.ctx.registry.resetDraft()
				return undefined
			}
			const injectMs = endInject()

			if (debugModules) {
				dbg!.debug(
					(l) =>
						l`execute ${this.path.pretty(id)} eval=${evaluateMs.toFixed(3)}ms inject=${injectMs.toFixed(3)}ms plugin=${hasPlugin}`,
				)
			}
		}

		const endCommit = startTimer()
		const res = await this.ctx.registry.commit()
		const commitMs = endCommit()

		if (!res.ok) {
			batch.rollback()
			this.ctx.registry.resetDraft()
		} else {
			batch.commit()
		}

		return { res, commitMs }
	}

	async runAndLoadAll(filesPath: readonly string[], keepOrder = true) {
		if (!filesPath.length) return undefined

		// Always normalize+dedupe in a single pass (avoid allocating an intermediate array).
		// `keepOrder=false` historically did not change ordering; preserve that behavior.
		const ordered = dedupeCleanIds(filesPath, (p) => this.path.toClean(p))
		return await this.runAndLoadAllClean(ordered, keepOrder)
	}
}

function buildCjsExternalizeHint(error: unknown): string | null {
	const ref = findRequireNotDefinedError(error)
	if (!ref) return null

	const stack = typeof ref?.stack === 'string' ? ref.stack : ''
	const offendingFile = extractOffendingFileFromStack(stack)
	const pkgFromFile = offendingFile ? tryReadNearestPackageName(offendingFile) : null
	const pkgFromStack = extractPackageNameFromStack(stack)
	const pkg = pkgFromFile ?? pkgFromStack
	const suggestion = pkg ? buildCjsExternalSuggestion(pkg) : '<your-cjs-package>'

	return [
		'[HMR] Detected a CommonJS-only dependency being evaluated as ESM (require is not defined).',
		'Add it to `hmrService.deps.cjsExternal` so it is externalized and executed by the host runtime.',
		offendingFile ? `Offending file: ${offendingFile}` : null,
		`Suggested entry: ${suggestion}`,
	]
		.filter(Boolean)
		.join('\n')
}

function findRequireNotDefinedError(error: unknown): { stack?: unknown } | null {
	const root = error as { cause?: unknown } | null
	for (const candidate of [error, root?.cause]) {
		if (!candidate || typeof candidate !== 'object') continue
		const c = candidate as { name?: unknown; message?: unknown; stack?: unknown }
		const name = typeof c.name === 'string' ? c.name : ''
		const message = typeof c.message === 'string' ? c.message : ''
		if (name === 'ReferenceError' && message.includes('require is not defined')) return c
	}
	return null
}

function buildCjsExternalSuggestion(pkg: string) {
	// Most packages should be externalized via exact specifier; use `/*` when importing subpaths.
	return `${pkg} (or ${pkg}/* for subpath imports)`
}

function extractOffendingFileFromStack(stack: string): string | null {
	if (!stack) return null

	// Prefer the first "eval (...)" entry, as it usually points to the actual CJS file being executed.
	{
		const m = stack.match(/\bat\s+eval\s+\(([^)]+?):\d+:\d+\)/)
		const p = m?.[1] ? stackLocationToFilePath(m[1]) : null
		if (p && existsSync(p)) return p
	}

	const paths = extractStackFilePaths(stack)
	for (const p of paths) {
		if (!existsSync(p)) continue
		// Skip common runner/evaluator internals that appear in every stack.
		if (p.includes('/node_modules/rolldown-vite/') || p.includes('/node_modules/vite/')) continue
		if (p.includes('/rolldown-vite/dist/') || p.includes('/vite/dist/')) continue
		if (p.includes('/dist/node/module-runner') || p.includes('/dist/node/chunks/')) continue
		return p
	}
	return null
}

function stackLocationToFilePath(loc: string): string | null {
	const cleaned = loc.split('?')[0]?.split('#')[0] ?? loc
	if (cleaned.startsWith('file://')) {
		try {
			return fileURLToPath(cleaned)
		} catch {
			return null
		}
	}
	return cleaned
}

function extractStackFilePaths(stack: string): string[] {
	const out: string[] = []
	const re = /\(([^)]+?):\d+:\d+\)/g
	for (const m of stack.matchAll(re)) {
		const p = m?.[1] ? stackLocationToFilePath(m[1]) : null
		if (p) out.push(p)
	}
	return out
}

function tryReadNearestPackageName(filePath: string): string | null {
	const pkgJson = findNearestPackageJson(filePath)
	if (!pkgJson) return null
	try {
		const raw = readFileSync(pkgJson, 'utf8')
		const json = JSON.parse(raw)
		return typeof json?.name === 'string' ? json.name : null
	} catch {
		return null
	}
}

function findNearestPackageJson(filePath: string): string | null {
	let dir = dirname(filePath)
	for (let i = 0; i < 30; i++) {
		const candidate = join(dir, 'package.json')
		if (existsSync(candidate)) return candidate
		const parent = dirname(dir)
		if (parent === dir) break
		dir = parent
	}
	return null
}

function extractPackageNameFromStack(stack: string): string | null {
	if (!stack) return null

	const ignored = new Set(['rolldown-vite', 'vite'])

	// pnpm layout: .../.pnpm/<name>@<ver>/node_modules/<name>/...
	for (const m of stack.matchAll(/\/\.pnpm\/([^/]+?)@[^/]+\/node_modules\/([^/]+)\//g)) {
		const pkg = m?.[2]
		if (pkg && !ignored.has(pkg)) return pkg
	}

	// npm/yarn: .../node_modules/<name>/...
	for (const m of stack.matchAll(/\/node_modules\/([^/]+)\//g)) {
		const first = m?.[1]
		if (!first) continue
		if (!first.startsWith('@')) {
			if (!ignored.has(first)) return first
			continue
		}
		// scoped: .../node_modules/@scope/name/...
		const scoped = stack.match(/\/node_modules\/(@[^/]+\/[^/]+)\//)
		if (scoped?.[1] && !ignored.has(scoped[1])) return scoped[1]
	}

	return null
}

export type HmrBatchConfig = {
	attribution: 'off' | 'prefetch'
	prefetchLimit: number
	prefetchOrder: PrefetchOrder
	prefetchConcurrency: number
}

export class HmrBatchProcessor {
	private anchorsClean: ReadonlySet<string> = new Set<string>()
	private readonly pathFilter: (id: string) => boolean
	private readonly inScope: ScopeFilter
	private readonly graphTools: GraphTools
	private readonly anchorFinder: NearestAnchorFinder
	private readonly variantsClean: (id: string) => string[]

	constructor(
		private readonly ctx: Context,
		private readonly env: DevEnvironment,
		private readonly runner: HmrRunner,
		private readonly executor: HmrExecutor,
		private readonly path: HmrPathApi,
		private readonly toolkit: HmrToolkit,
		private readonly timing: TimingTracker,
		private readonly cfg: HmrBatchConfig,
		private readonly dbg: {
			batch: LogtapeLogger | null
			cache: LogtapeLogger | null
			graph: LogtapeLogger | null
		},
		private readonly getAnchorsClean: () => ReadonlySet<string>,
	) {
		this.pathFilter = this.toolkit.pathFilter
		this.inScope = (id) => this.anchorsClean.has(id) || this.pathFilter(id)
		this.graphTools = new GraphTools(this.env, this.path, this.inScope)
		this.anchorFinder = new NearestAnchorFinder(this.graphTools, this.path)
		this.variantsClean = this.path.variantsClean ?? this.path.variants
	}

	async process(files: readonly string[], epoch: number) {
		const changed = dedupeIds(files)
		if (changed.length === 0) return

		const endBatch = startTimer()
		this.timing.clear()
		const dbg = this.dbg.batch
		dbg?.debug((l) => l`batch #${epoch} begin: ${changed.length} files`)

		this.logBatchList('changed files', changed)

		this.pruneMissingModules(changed)
		this.anchorsClean = this.getAnchorsClean()
		this.anchorFinder.clear()
		const anchorsClean = this.anchorsClean

		const graph = this.graphTools.collectBatchGraph(changed)
		this.logGraphDebug(graph)
		const invalidated = this.invalidateCaches(graph.affectedIds)

		const targets = pickTargetsByAnchors({
			affectedIds: graph.affectedIds,
			fallbackRoots: graph.roots,
			anchors: anchorsClean,
			toClean: (id) => id,
			findNearestAnchor: (startCleanId, anchors) => this.anchorFinder.find(startCleanId, anchors),
		})
		this.logBatchList('targets', [...targets])

		if (this.cfg.attribution === 'prefetch') {
			const prefetchList = buildOrderedList(
				targets.size ? targets : graph.affectedIds,
				graph.distance,
				this.cfg.prefetchOrder,
				this.cfg.prefetchLimit,
			)
			if (prefetchList.length) {
				await prefetchTransforms({
					env: this.env,
					ids: prefetchList,
					timing: this.timing,
					concurrency: this.cfg.prefetchConcurrency,
				})
			}
		}

		const execOrder = buildOrderedList(targets, graph.distance, 'near', targets.size || 1)
		const executed = await this.executor.runAndLoadAllClean(execOrder, true)
		const commitMs = executed ? Math.round(executed.commitMs * 10) / 10 : null

		if (this.cfg.attribution === 'prefetch') {
			logAttributionReport(
				this.ctx.logger,
				{
					changed: changed[0] ?? 'N/A',
					targets: execOrder,
					timing: this.timing,
					prettyId: (id) => this.path.pretty(id),
				},
				{ level: 'debug' },
			)
		}

		const activeServices = this.ctx.registry.container?.services.size ?? 0
		const { plugins: pluginTotals } = collectPluginTotals({
			registryView: this.ctx.loader.api.registry,
			isEnabledInConfig: (name) => this.ctx.configService.isEnabledInConfig(name),
			isRunning: (ctor) => this.ctx.registry.isRunning(ctor),
		})
		const hotspots = collectHotspots(this.timing, (id) => this.path.pretty(id))
		const batchMs = Math.round(endBatch() * 10) / 10
		this.ctx.logger.info('HMR updated', {
			epoch,
			changedFiles: changed.length,
			targets: execOrder.length,
			affected: graph.affectedIds.size,
			fallbackRoots: graph.roots.length,
			activeServices,
			plugins: pluginTotals,
			hotspots: hotspots.length ? hotspots : undefined,
			invalidated,
			commitMs,
			batchMs,
		})
	}

	private logBatchList(label: string, files: readonly string[]) {
		const dbg = this.dbg.batch
		if (!isLogEnabled(dbg, 'debug')) return
		dbg.debug((l) => {
			const list = files.map((f) => this.path.pretty(f))
			return l`${label} (${list.length})\n${list.map((f) => `    ${f}`).join('\n')}`
		})
	}

	private logGraphDebug(graph: BatchGraph) {
		const dbg = this.dbg.graph
		if (!isLogEnabled(dbg, 'debug')) return
		dbg.debug((l) => {
			const affectedList = [...graph.affectedIds].map((id) => {
				const d = graph.distance.get(id) ?? -1
				return `${this.path.pretty(id)} (d=${d})`
			})
			return l`affected (${affectedList.length})\n${affectedList.map((x) => `    ${x}`).join('\n')}`
		})
		dbg.debug((l) => {
			const roots = graph.roots.map((r) => this.path.pretty(r))
			return l`roots (${roots.length})\n${roots.map((x) => `    ${x}`).join('\n')}`
		})
	}

	private pruneMissingModules(files: readonly string[]) {
		for (const file of files) {
			// Only prune for actual deletions. New files may not exist in the module graph yet.
			// The watcher reports real filesystem paths here (normalized to `toClean` upstream).
			if (existsSync(file)) continue

			if (this.ctx.loader.api.anchors.has(file)) this.ctx.loader.api.anchors.remove(file)
			this.ctx.loader.pruneModule(file)
		}
	}

	private invalidateCaches(affectedIds: ReadonlySet<string>) {
		const g = this.env.moduleGraph
		let viteInvalidated = 0
		const invalidatedModules = new Set<ModuleNode>()

		for (const id of affectedIds) {
			const variants = this.variantsClean(id)
			for (const variant of variants) {
				const mods = g.getModulesByFile(variant)
				if (mods?.size) {
					for (const m of mods) {
						if (invalidatedModules.has(m)) continue
						invalidatedModules.add(m)
						g.invalidateModule(m)
						viteInvalidated++
					}
				} else {
					const m = g.getModuleById(variant)
					if (m && !invalidatedModules.has(m)) {
						invalidatedModules.add(m)
						g.invalidateModule(m)
						viteInvalidated++
					}
				}
			}
		}

		const { invalidated: runnerInvalidated, invalidatedKeys } =
			this.runner.invalidateRunnerCacheByFiles(affectedIds)

		const dbg = this.dbg.cache
		if (isLogEnabled(dbg, 'debug')) {
			dbg.debug((l) => l`invalidated: vite=${viteInvalidated} runner=${runnerInvalidated}`)
			if (invalidatedKeys.length) {
				dbg.debug((l) => {
					const keys = invalidatedKeys.map((k) => this.path.pretty(k))
					return l`runner keys (${keys.length})\n${keys.map((k) => `    ${k}`).join('\n')}`
				})
			}
		}
		return { vite: viteInvalidated, runner: runnerInvalidated }
	}
}
