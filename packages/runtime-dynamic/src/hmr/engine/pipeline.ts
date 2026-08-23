import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Logger as LogtapeLogger } from '@logtape/logtape'
import { formatPluginNodeReference, type Context, type PluginNodeAddress } from '@pluxel/core'
import { requirePluginService } from '@pluxel/core/internal'
import { dirname, join } from 'pathe'
import type { DevEnvironment, EnvironmentModuleNode as ModuleNode } from 'vite'
import { isPluginEnabled, requireRuntimeStateStore, startTimer } from '@pluxel/runtime/internal'
import type { LoaderBatch } from '../../loader/support'
import type { LoaderService } from '../../loader/LoaderService'
import {
	HMR_CHANGED_PREVIEW_LIMIT,
	hmrChangedPreviewProps,
	hmrInvalidated,
	hmrOptionalCount,
	hmrOptionalList,
	roundHmrMs,
	type HmrInvalidationCounts,
	type HmrPluginTotals,
	type HmrUpdatedLogProps,
} from '@pluxel/runtime-dev/hmr-log'
import type { HmrPathApi, HmrToolkit } from './environment'
import { collectHotspots, isLogEnabled, logAttributionReport, type TimingTracker } from './logging'
import { collectPluginTotals } from './operational-report'
import type { HmrRunner } from './runner'
import { runWithRequireShims } from './runtime-shims'
import { requireLoaderService } from '../../context-plan'

export type PrefetchOrder = 'near' | 'all'

type RuntimeCommitResult = Readonly<{ ok: true; val: null }> | Readonly<{ ok: false; err: unknown }>
const createRuntimeCommitFailureResult = (cause: unknown): RuntimeCommitResult => ({
	ok: false,
	err: cause,
})

function formatErrorMessage(error: unknown): string {
	if (error instanceof Error) return error.message || error.name
	return String(error)
}

export type HmrExecutionResult = {
	commitResult: RuntimeCommitResult
	commitMs: number
	affectedModules: readonly string[]
	syncedModules: readonly string[]
	autoDisabled: readonly string[]
	executeError?: string
	injectError?: string
}

export type PrefetchTransformResult = {
	attempted: number
	failed: number
	failedIds: readonly string[]
}

export type PluginStatusSnapshotLike = {
	statuses?: readonly {
		address: PluginNodeAddress
		isEnabled?: boolean
		isRunning?: boolean
	}[]
}

export type EnabledButStoppedLookup = {
	api: {
		status: {
			snapshot: () => PluginStatusSnapshotLike
		}
		registry: {
			findModuleId(address: PluginNodeAddress): string | null
		}
	}
}

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

type BatchGraph = {
	affectedIds: Set<string>
	roots: string[]
	distance: Map<string, number>
}

type ScopeFilter = (cleanId: string) => boolean

export class GraphTools {
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
	private readonly inScope: ScopeFilter

	constructor(env: DevEnvironment, path: HmrPathApi, inScope: ScopeFilter) {
		this.moduleGraph = env.moduleGraph
		this.toClean = path.toClean
		this.variantsAny = path.variants
		this.variantsClean = path.variantsClean ?? path.variants
		this.inScope = inScope
	}

	collectModulesByFile(fileOrId: string, out: ModuleNode[]): number {
		out.length = 0
		const first = fileOrId.charCodeAt(0)
		const variants =
			first === 47 || first === 0 ? this.variantsClean(fileOrId) : this.variantsAny(fileOrId)
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
			if (visited.has(id)) continue

			visited.add(id)
			if (inScope(id)) {
				affectedIds.add(id)
				idToNode.set(id, m)
				distance.set(id, d)
			}

			// A changed dependency may sit outside declared source globs. Continue through its
			// importer chain until reaching source-owned modules instead of dropping the batch.
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
	env: Pick<DevEnvironment, 'fetchModule'>
	ids: Iterable<string>
	timing: Pick<TimingTracker, 'start'>
	concurrency: number
}): Promise<PrefetchTransformResult> {
	const seen = new Set<string>()
	const queue: string[] = []

	for (const raw of params.ids) {
		const id = raw
		if (seen.has(id)) continue
		seen.add(id)
		queue.push(id)
	}
	if (queue.length === 0) return { attempted: 0, failed: 0, failedIds: [] }

	let cursor = 0
	const workerCount = Math.min(params.concurrency, queue.length)
	let failed = 0
	const failedIds: string[] = []

	const worker = async () => {
		while (true) {
			const index = cursor++
			if (index >= queue.length) break
			const id = queue[index]
			const end = params.timing.start('transform', id)
			try {
				await params.env.fetchModule(id)
			} catch {
				// Transform prefetch is a latency optimization. Evaluation still owns correctness.
				failed++
				failedIds.push(id)
			} finally {
				end()
			}
		}
	}

	await Promise.all(Array.from({ length: workerCount }, () => worker()))
	return { attempted: queue.length, failed, failedIds }
}

export type HmrExecutorConfig = {
	useRequireShims: boolean
	dbgModules: LogtapeLogger | null
}

class HmrRuntimeCommitScheduler {
	async commitBatch(batch: LoaderBatch): Promise<HmrExecutionResult> {
		const endCommit = startTimer()
		let commitResult: RuntimeCommitResult
		try {
			await batch.commit({ reason: 'hmr' })
			commitResult = { ok: true, val: null }
		} catch (error) {
			commitResult = createRuntimeCommitFailureResult(error)
			batch.rollback()
		}

		const commitMs = endCommit()
		return {
			commitResult,
			commitMs,
			affectedModules: [],
			syncedModules: [],
			autoDisabled: [],
		}
	}
}

export class HmrExecutor {
	private readonly commitScheduler: HmrRuntimeCommitScheduler
	private readonly loader: LoaderService

	constructor(
		private readonly ctx: Context,
		private readonly runner: HmrRunner,
		private readonly path: HmrPathApi,
		private readonly timing: Pick<TimingTracker, 'start'>,
		private readonly cfg: HmrExecutorConfig,
	) {
		this.commitScheduler = new HmrRuntimeCommitScheduler()
		this.loader = requireLoaderService(ctx)
	}

	private pickRunnerImportId(cleanId: string): string {
		const variants = this.path.variantsClean
			? this.path.variantsClean(cleanId)
			: this.path.variants(cleanId)

		// Prefer Vite's `/@fs` form for filesystem ids (more reliable across runner implementations).
		for (const v of variants) {
			if (typeof v === 'string' && v.startsWith('/@fs/')) return v
		}
		return cleanId
	}

	async runAndLoadAllClean(
		cleanIds: readonly string[],
		_keepOrder = true,
		removedIds: readonly string[] = [],
	): Promise<HmrExecutionResult | undefined> {
		if (cleanIds.length === 0 && removedIds.length === 0) return undefined

		// Historically `keepOrder=false` did not change ordering; preserve that behavior.
		const ordered = dedupeIds(cleanIds)

		const batch = this.loader.beginBatch()
		const dbg = this.cfg.dbgModules
		const debugModules = dbg ? isLogEnabled(dbg, 'debug') : false

		for (const id of dedupeIds(removedIds)) {
			batch.removeModule(id)
		}

		for (let i = 0; i < ordered.length; i++) {
			const id = ordered[i]!
			const endEvaluate = this.timing.start('evaluate', id)
			let mod: Record<string, unknown>
			try {
				const importId = this.pickRunnerImportId(id)
				const evaluate = () => this.runner.import(importId)
				mod = (
					this.cfg.useRequireShims ? await runWithRequireShims(evaluate) : await evaluate()
				) as Record<string, unknown>
			} catch (err) {
				endEvaluate()
				const cjsHint = buildHostModuleClassificationHint(err)
				if (cjsHint) {
					this.ctx.logger.error('execute failed for {file}', { file: id, error: err })
					const error = new Error(cjsHint, { cause: err })
					batch.rollback()
					return {
						commitResult: createRuntimeCommitFailureResult(error),
						commitMs: 0,
						affectedModules: [],
						syncedModules: [],
						autoDisabled: [],
						executeError: cjsHint,
					}
				}
				this.ctx.logger.error('execute failed for {file}', { file: id, error: err })
				batch.rollback()
				return {
					commitResult: createRuntimeCommitFailureResult(err),
					commitMs: 0,
					affectedModules: [],
					syncedModules: [],
					autoDisabled: [],
					executeError: formatErrorMessage(err),
				}
			}
			const evaluateMs = endEvaluate()

			const endInject = this.timing.start('inject', id)
			let hasPlugin = false
			try {
				const result = await batch.replaceModule(id, mod)
				hasPlugin = result.isAnchor
			} catch (err) {
				this.ctx.logger.error('replaceModule failed for {file}', { file: id, error: err })
				batch.rollback()
				return {
					commitResult: createRuntimeCommitFailureResult(err),
					commitMs: 0,
					affectedModules: [],
					syncedModules: [],
					autoDisabled: [],
					injectError: formatErrorMessage(err),
				}
			}
			const injectMs = endInject()

			if (debugModules) {
				dbg!.debug(
					(l) =>
						l`execute ${this.path.pretty(id)} eval=${evaluateMs.toFixed(3)}ms inject=${injectMs.toFixed(3)}ms plugin=${hasPlugin}`,
				)
			}
		}

		return await this.commitScheduler.commitBatch(batch)
	}

	async runAndLoadAll(
		filesPath: readonly string[],
		keepOrder = true,
	): Promise<HmrExecutionResult | undefined> {
		if (filesPath.length === 0) return undefined

		// Always normalize+dedupe in a single pass (avoid allocating an intermediate array).
		// `keepOrder=false` historically did not change ordering; preserve that behavior.
		const ordered = dedupeCleanIds(filesPath, (p) => this.path.toClean(p))
		return await this.runAndLoadAllClean(ordered, keepOrder)
	}
}

export function collectEnabledButStopped(
	loader: EnabledButStoppedLookup,
	moduleIds: ReadonlySet<string>,
): readonly string[] {
	if (moduleIds.size === 0) return []
	const snapshot = loader.api.status.snapshot()
	const statuses = snapshot.statuses ?? []
	const out: string[] = []
	for (const status of statuses) {
		if (!status?.isEnabled || status.isRunning) continue
		const moduleId = loader.api.registry.findModuleId(status.address)
		if (!moduleId || !moduleIds.has(moduleId)) continue
		out.push(formatPluginNodeReference(status.address))
	}
	out.sort((a, b) => a.localeCompare(b))
	return out
}

function buildHostModuleClassificationHint(error: unknown): string | null {
	const ref = findRequireNotDefinedError(error)
	if (!ref) return null

	const stack = typeof ref?.stack === 'string' ? ref.stack : ''
	const offendingFile = extractOffendingFileFromStack(stack)
	const pkgFromFile = offendingFile ? tryReadNearestPackageName(offendingFile) : null
	const pkgFromStack = extractPackageNameFromStack(stack)
	const pkg = pkgFromFile ?? pkgFromStack

	return [
		'[HMR] A CommonJS dependency reached the ESM evaluator after automatic host-module classification.',
		'Ensure its package.json declares CommonJS (`type`, `require` export) or native (`napi`, `binary`, `gypfile`) metadata.',
		offendingFile ? `Offending file: ${offendingFile}` : null,
		pkg ? `Package: ${pkg}` : null,
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
	/**
	 * Attribution (timing ranking) report output level.
	 *
	 * Note: this is independent from transform prefetching. Prefetch is enabled only when
	 * `prefetchConcurrency > 0` and `prefetchLimit > 0`.
	 */
	attributionLevel: 'off' | 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'
	prefetchLimit: number
	prefetchOrder: PrefetchOrder
	prefetchConcurrency: number
}

export type HmrPluginChanges = {
	added: readonly string[]
	replaced: readonly { from: string; to: string }[]
	removed: readonly string[]
	availabilityChanged: readonly string[]
	restarted: readonly string[]
}

export type HmrPluginLifecycleReport = {
	ok: boolean
	issues: readonly {
		plugin: string
		phase: string
		kind: string
		message: string
		error?: { name: string; message: string; stack?: string; cause?: string }
		blockedBy?: string
	}[]
}

export type HmrBatchSummary = {
	epoch: number
	changed: readonly string[]
	targets: readonly string[]
	/**
	 * Modules reported by the runtime dynamic as DI dependents of replaced plugin modules.
	 *
	 * These may not be Vite execution targets; HMR syncs them through the loader before commit so core
	 * can apply lifecycle restart semantics with the latest runtime ctor map.
	 */
	affectedModules: readonly string[]
	/** Runtime modules successfully re-synced into the core draft before commit. */
	syncedModules: readonly string[]
	/** Plugins persisted-disabled by the missing-dependency retry policy during this batch. */
	autoDisabled: readonly string[]
	/**
	 * Enabled plugins in this batch's related module set that were still not running after commit.
	 *
	 * This catches lifecycle failures that do not make the batch itself fail.
	 */
	enabledButStopped: readonly string[]
	affected: number
	fallbackRoots: number
	invalidated: HmrInvalidationCounts
	activeServices: number
	plugins: HmrPluginTotals
	commitMs: number | null
	batchMs: number
	/**
	 * Batch-level success flag (HMR pipeline semantics).
	 *
	 * This reflects whether the HMR batch itself ran successfully (build/evaluate/inject/commit orchestration),
	 * not whether every plugin lifecycle started successfully.
	 */
	ok: boolean
	commitError?: string
	executeError?: string
	injectError?: string
	prefetchFailed: number
	/**
	 * Formatted plugin change summary from the core plugin system (when available).
	 *
	 * Note: core commit is non-transactional; plugin changes can be applied even when some plugin
	 * lifecycles fail to start.
	 */
	pluginChanges?: HmrPluginChanges
	/** Plugin lifecycle report from the core plugin system, when this batch committed plugin changes. */
	pluginLifecycleReport?: HmrPluginLifecycleReport
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

	async process(files: readonly string[], epoch: number): Promise<HmrBatchSummary | null> {
		const changed = dedupeIds(files)
		if (changed.length === 0) return null

		const endBatch = startTimer()
		this.timing.clear()
		const dbg = this.dbg.batch
		dbg?.debug((l) => l`batch #${epoch} begin: ${changed.length} files`)

		this.logBatchList('changed files', changed)

		this.anchorsClean = this.getAnchorsClean()
		this.anchorFinder.clear()
		const anchorsClean = this.anchorsClean

		const graph = this.graphTools.collectBatchGraph(changed)
		const removed = changed.filter((file) => !existsSync(file))
		this.logGraphDebug(graph)
		const invalidated = this.invalidateCaches(graph.affectedIds)
		let prefetchFailed = 0

		const targets = pickTargetsByAnchors({
			affectedIds: graph.affectedIds,
			fallbackRoots: graph.roots,
			anchors: anchorsClean,
			toClean: (id) => id,
			findNearestAnchor: (startCleanId, anchors) => this.anchorFinder.find(startCleanId, anchors),
		})
		for (const file of removed) targets.delete(file)
		this.logBatchList('targets', [...targets])

		if (this.cfg.prefetchConcurrency > 0 && this.cfg.prefetchLimit > 0) {
			const prefetchList = buildOrderedList(
				targets.size > 0 ? targets : graph.affectedIds,
				graph.distance,
				this.cfg.prefetchOrder,
				this.cfg.prefetchLimit,
			)
			if (prefetchList.length > 0) {
				const prefetch = await prefetchTransforms({
					env: this.env,
					ids: prefetchList,
					timing: this.timing,
					concurrency: this.cfg.prefetchConcurrency,
				})
				prefetchFailed = prefetch.failed
			}
		}

		const execOrder = buildOrderedList(targets, graph.distance, 'near', targets.size || 1)
		const ignored = graph.affectedIds.size === 0
		const executed = ignored
			? null
			: await this.executor.runAndLoadAllClean(execOrder, true, removed)
		const commitMs = executed ? roundHmrMs(executed.commitMs) : null
		const affectedModules = executed?.affectedModules ?? []
		const syncedModules = executed?.syncedModules ?? []
		const autoDisabled = executed?.autoDisabled ?? []
		const executeError = executed?.executeError
		const injectError = executed?.injectError

		const attrLevel = this.cfg.attributionLevel
		if (attrLevel !== 'off') {
			logAttributionReport(
				this.ctx.logger,
				{
					changed: changed[0] ?? 'N/A',
					targets: execOrder,
					timing: this.timing,
					prettyId: (id) => this.path.pretty(id),
				},
				{ level: attrLevel },
			)
		}

		const pluginService = requirePluginService(this.ctx)
		const activeServices = pluginService.graph.activeCount()
		const loader = requireLoaderService(this.ctx)
		const pluginTotals = collectPluginTotals({
			registryView: loader.api.registry,
			isPluginEnabled: (address) =>
				isPluginEnabled(requireRuntimeStateStore(this.ctx).snapshot(), address),
			isRunning: (address) => pluginService.isRunning(address),
		})
		const hotspots = collectHotspots(this.timing, (id) => this.path.pretty(id))
		const batchMs = roundHmrMs(endBatch())
		const commitOk = ignored || Boolean(executed?.commitResult.ok)
		const commitError =
			!executeError && !injectError && executed?.commitResult.ok === false
				? String(executed.commitResult.err ?? 'commit failed')
				: undefined
		const relatedModules = new Set<string>([
			...execOrder,
			...affectedModules,
			...syncedModules,
			...graph.affectedIds,
		])
		const enabledButStopped = collectEnabledButStopped(loader, relatedModules)

		const changedPretty = [...new Set(changed.map((id) => this.path.pretty(id)))].sort()
		const logProps = {
			epoch,
			changedFiles: changed.length,
			...hmrChangedPreviewProps(changedPretty, HMR_CHANGED_PREVIEW_LIMIT),
			targets: execOrder.length,
			affectedModules: hmrOptionalCount(affectedModules.length),
			syncedModules: hmrOptionalCount(syncedModules.length),
			autoDisabled: hmrOptionalList(autoDisabled),
			enabledButStopped: hmrOptionalList(enabledButStopped),
			affected: graph.affectedIds.size,
			fallbackRoots: graph.roots.length,
			activeServices,
			plugins: pluginTotals,
			hotspots: hmrOptionalList(hotspots),
			invalidated,
			prefetchFailed: hmrOptionalCount(prefetchFailed),
			commitMs,
			batchMs,
			ok: commitOk,
			...(executeError ? { executeError } : {}),
			...(injectError ? { injectError } : {}),
			...(commitError ? { commitError } : {}),
		} satisfies HmrUpdatedLogProps
		if (ignored) this.ctx.logger.debug('HMR ignored', logProps)
		else if (commitOk) this.ctx.logger.info('HMR updated', logProps)
		else this.ctx.logger.warn('HMR updated', logProps)

		return {
			epoch,
			changed,
			targets: execOrder,
			affectedModules,
			syncedModules,
			autoDisabled,
			enabledButStopped,
			affected: graph.affectedIds.size,
			fallbackRoots: graph.roots.length,
			activeServices,
			plugins: pluginTotals,
			invalidated,
			prefetchFailed,
			commitMs,
			batchMs,
			ok: commitOk,
			...(executeError ? { executeError } : {}),
			...(injectError ? { injectError } : {}),
			...(commitError ? { commitError } : {}),
		}
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
			if (invalidatedKeys.length > 0) {
				dbg.debug((l) => {
					const keys = invalidatedKeys.map((k) => this.path.pretty(k))
					return l`runner keys (${keys.length})\n${keys.map((k) => `    ${k}`).join('\n')}`
				})
			}
		}
		return hmrInvalidated(viteInvalidated, runnerInvalidated)
	}
}
