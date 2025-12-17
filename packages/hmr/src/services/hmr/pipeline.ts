import type { Context } from '@pluxel/core'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { glob } from 'tinyglobby'
import { normalizePath, type DevEnvironment, type EnvironmentModuleNode as ModuleNode } from 'vite'
import type { ScanService } from '../market/ScanService'
import type { HmrPathApi, HmrToolkit } from './environment'
import { startTimer } from './internals'
import { formatAttributionReport, type TimingTracker } from './logging'
import { runWithRequireShims } from './runtime-shims'
import type { HmrRunner } from './runner'

const unique = <T>(iter: Iterable<T>) => Array.from(new Set(iter))

export type PrefetchOrder = 'near' | 'all'

export async function collectColdStartEntries(params: {
	rootsAbs: readonly string[]
	anchors: ReadonlySet<string>
	path: HmrPathApi
	scanService?: ScanService
	workspaceConditions: readonly string[]
}) {
	const entries = new Set<string>()
	for (const anchor of params.anchors) entries.add(params.path.toClean(anchor))

	const rootInfos = params.rootsAbs.map((raw) => ({ raw, normalized: normalizePath(raw) }))
	const workspace = await tryCollectWorkspaceEntries({
		rootInfos,
		path: params.path,
		scanService: params.scanService,
		workspaceConditions: params.workspaceConditions,
	})
	if (workspace) for (const entry of workspace.entries) entries.add(entry)

	const covered = workspace?.covered
	const uncovered = covered
		? rootInfos.filter((info) => !covered.has(info.normalized)).map((info) => info.raw)
		: rootInfos.map((info) => info.raw)

	if (uncovered.length) {
		const fallbackEntries = await collectDirectoryFallbackEntries(uncovered, params.path)
		for (const entry of fallbackEntries) entries.add(entry)
	}

	return [...entries]
}

async function tryCollectWorkspaceEntries(params: {
	rootInfos: Array<{ raw: string; normalized: string }>
	path: HmrPathApi
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
		for (const pkg of workspaceEntries) {
			entries.push(params.path.toClean(pkg.entry))
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

async function collectDirectoryFallbackEntries(roots: readonly string[], path: HmrPathApi) {
	const patterns = roots.flatMap((root) => [`${root}/**/*.ts`])
	const files = await glob(patterns, {
		absolute: true,
		onlyFiles: true,
		ignore: ['**/*.d.ts', '**/node_modules/**'],
	})
	return Array.from(new Set(files.map((file) => path.toClean(file))))
}

type BatchGraph = {
	affectedIds: Set<string>
	roots: string[]
	distance: Map<string, number>
}

type ScopeFilter = (cleanId: string) => boolean

class GraphTools {
	constructor(
		private readonly env: DevEnvironment,
		private readonly path: HmrPathApi,
		private readonly inScope: ScopeFilter,
	) {}

	getModulesByFile(fileOrId: string): ModuleNode[] {
		const variants = this.path.variants(fileOrId)
		for (const variant of variants) {
			const byFile = this.env.moduleGraph.getModulesByFile(variant)
			if (byFile?.size) return [...byFile]
		}
		for (const variant of variants) {
			const single = this.env.moduleGraph.getModuleById(variant)
			if (single) return [single]
		}
		return []
	}

	collectBatchGraph(files: readonly string[]): BatchGraph {
		const visited = new Set<string>()
		const affectedIds = new Set<string>()
		const idToNode = new Map<string, ModuleNode>()
		const distance = new Map<string, number>()

		const queue: ModuleNode[] = []
		const queueDist: number[] = []

		for (const file of files) {
			const mods = this.getModulesByFile(file)
			for (const m of mods) {
				queue.push(m)
				queueDist.push(0)
			}

			const clean = this.path.toClean(file)
			if (mods.length === 0 && this.inScope(clean) && !visited.has(clean)) {
				visited.add(clean)
				affectedIds.add(clean)
				distance.set(clean, 0)
			}
		}

		for (let cursor = 0; cursor < queue.length; cursor++) {
			const m = queue[cursor]
			const d = queueDist[cursor] ?? 0
			if (!m?.id) continue

			const id = this.path.toClean(m.id)
			if (id.startsWith('\0')) continue
			if (!this.inScope(id)) continue
			if (visited.has(id)) continue

			visited.add(id)
			affectedIds.add(id)
			idToNode.set(id, m)
			distance.set(id, d)

			for (const importer of m.importers) {
				if (!importer?.id) continue
				queue.push(importer)
				queueDist.push(d + 1)
			}
		}

		const roots: string[] = []
		for (const id of affectedIds) {
			const m = idToNode.get(id)
			if (!m) {
				roots.push(id)
				continue
			}
			let hasImporterInside = false
			for (const importer of m.importers) {
				if (!importer?.id) continue
				const importerId = this.path.toClean(importer.id)
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

		const visited = new Set<string>()
		const queue: ModuleNode[] = this.graph.getModulesByFile(startCleanId)

		for (let cursor = 0; cursor < queue.length; cursor++) {
			const m = queue[cursor]
			if (!m?.id) continue
			const id = this.path.toClean(m.id)
			if (visited.has(id)) continue
			visited.add(id)

			if (id.startsWith('\0') || id.includes('/node_modules/')) continue

			if (anchors.has(id)) {
				this.cache.set(startCleanId, id)
				return id
			}

			for (const importer of m.importers) if (importer?.id) queue.push(importer)
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
}): string[] {
	const targets = new Set<string>()
	let needFallbackRoots = false

	for (const id of params.affectedIds) {
		const anchor = params.findNearestAnchor(id, params.anchors)
		if (anchor) targets.add(anchor)
		else needFallbackRoots = true
	}

	if (needFallbackRoots) {
		for (const r of params.fallbackRoots) targets.add(params.toClean(r))
	}

	return [...targets]
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

async function prefetchTransforms(params: {
	env: DevEnvironment
	ids: Iterable<string>
	path: HmrPathApi
	timing: TimingTracker
	concurrency: number
}) {
	const seen = new Set<string>()
	const queue: string[] = []

	for (const raw of params.ids) {
		const id = params.path.toClean(raw)
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
	dbgModules: ((fmt: string, ...args: any[]) => void) | null
}

export class HmrExecutor {
	constructor(
		private readonly ctx: Context,
		private readonly runner: HmrRunner,
		private readonly path: HmrPathApi,
		private readonly timing: TimingTracker,
		private readonly cfg: HmrExecutorConfig,
	) {}

	async runAndLoadAll(filesPath: readonly string[], keepOrder = true) {
		if (!filesPath.length) return undefined

		const dedup = unique(filesPath.map((p) => this.path.toClean(p)))
		const ordered = keepOrder ? dedup : [...dedup]

		const batch = this.ctx.loader.beginBatch()

		for (const id of ordered) {
			const endEvaluate = this.timing.start('evaluate', id)
			let mod: any
			try {
				const evaluate = () => this.runner.import(id)
				mod = this.cfg.useRequireShims ? await runWithRequireShims(evaluate) : await evaluate()
			} catch (err) {
				// Hard fail on CJS deps being evaluated as ESM (common for native wrappers),
				// so users must explicitly externalize them via `hmrService.deps.cjsExternal`.
				const cjsHint = buildCjsExternalizeHint(err)
				if (cjsHint) {
					this.ctx.logger.error({ file: id, err }, '[HMR] execute failed')
					throw new Error(cjsHint, { cause: err as any })
				}
				this.ctx.logger.error({ file: id, err }, '[HMR] execute failed')
				continue
			}
			const evaluateMs = endEvaluate()

			const endInject = this.timing.start('inject', id)
			let hasPlugin = false
			try {
				hasPlugin = await batch.replaceModule(id, mod)
			} catch (err) {
				this.ctx.logger.error({ file: id, err }, '[HMR] replaceModule failed')
				batch.rollback()
				this.ctx.registry.resetDraft()
				return undefined
			}
			const injectMs = endInject()

			this.cfg.dbgModules?.(
				'execute %p: eval=%t inject=%t plugin=%b',
				this.path.pretty(id),
				evaluateMs,
				injectMs,
				hasPlugin,
			)
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

function findRequireNotDefinedError(error: unknown): any | null {
	const e: any = error
	for (const candidate of [e, e?.cause]) {
		const name = typeof candidate?.name === 'string' ? candidate.name : ''
		const message = typeof candidate?.message === 'string' ? candidate.message : ''
		if (name === 'ReferenceError' && message.includes('require is not defined')) return candidate
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
			batch: ((fmt: string, ...args: any[]) => void) | null
			cache: ((fmt: string, ...args: any[]) => void) | null
			graph: ((fmt: string, ...args: any[]) => void) | null
		},
		private readonly getAnchorsClean: () => ReadonlySet<string>,
	) {}

	async process(files: readonly string[], epoch: number) {
		const endBatch = startTimer()
		this.timing.clear()
		this.ctx.logger.info('[HMR#%d] begin: %d files', epoch, files.length)

		this.logBatchList('changed files', files)

		this.pruneMissingModules(files)
		const anchorsClean = this.getAnchorsClean()

		const inScope = (id: string) => anchorsClean.has(id) || this.toolkit.pathFilter(id)
		const graphTools = new GraphTools(this.env, this.path, inScope)
		const anchorFinder = new NearestAnchorFinder(graphTools, this.path)

		const graph = graphTools.collectBatchGraph(files)
		this.logGraphDebug(graph)
		this.invalidateCaches(graph.affectedIds)

		const targets = pickTargetsByAnchors({
			affectedIds: graph.affectedIds,
			fallbackRoots: graph.roots,
			anchors: anchorsClean,
			toClean: (id) => this.path.toClean(id),
			findNearestAnchor: (startCleanId, anchors) => anchorFinder.find(startCleanId, anchors),
		})
		this.logBatchList('targets', targets)

		if (this.cfg.attribution === 'prefetch') {
			const prefetchList = buildOrderedList(
				targets.length ? new Set(targets) : graph.affectedIds,
				graph.distance,
				this.cfg.prefetchOrder,
				this.cfg.prefetchLimit,
			)
			if (prefetchList.length) {
				await prefetchTransforms({
					env: this.env,
					ids: prefetchList,
					path: this.path,
					timing: this.timing,
					concurrency: this.cfg.prefetchConcurrency,
				})
			}
		}

		const execOrder = buildOrderedList(new Set(targets), graph.distance, 'near', targets.length || 1)
		const executed = await this.executor.runAndLoadAll(execOrder, true)
		if (executed) this.ctx.logger.info('[HMR] commit: %sms', executed.commitMs.toFixed(1))

		this.ctx.logger.info(
			formatAttributionReport({
				changed: files[0] ?? 'N/A',
				targets: execOrder,
				timing: this.timing,
				prettyId: (id) => this.path.pretty(id),
			}),
		)

		const activeServices = this.ctx.registry.container?.services.size ?? 0
		this.ctx.logger.info('[HMR#%d] end: %d services, %sms', epoch, activeServices, endBatch().toFixed(1))
	}

	private logBatchList(label: string, files: readonly string[]) {
		const dbg = this.dbg.batch
		if (!dbg) return
		dbg(
			'%s (%n): %l',
			label,
			files.length,
			files.map((f) => this.path.pretty(f)),
		)
	}

	private logGraphDebug(graph: BatchGraph) {
		const dbg = this.dbg.graph
		if (!dbg) return
		const affectedList = [...graph.affectedIds].map((id) => {
			const d = graph.distance.get(id) ?? -1
			return `${this.path.pretty(id)} (d=${d})`
		})
		dbg('affected (%n): %l', graph.affectedIds.size, affectedList)
		dbg(
			'roots (%n): %l',
			graph.roots.length,
			graph.roots.map((r) => this.path.pretty(r)),
		)
	}

	private pruneMissingModules(files: readonly string[]) {
		for (const file of files) {
			const mods = this.env.moduleGraph.getModulesByFile(file)
			const exists = mods?.size || this.env.moduleGraph.getModuleById(file)
			if (exists) continue

			for (const a of this.ctx.loader.pathAnchors) {
				if (this.path.toClean(a) === file) this.ctx.loader.pathAnchors.delete(a)
			}
			this.ctx.loader.pruneModule(file)
		}
	}

	private invalidateCaches(affectedIds: ReadonlySet<string>) {
		const g = this.env.moduleGraph
		let viteInvalidated = 0

		for (const id of affectedIds) {
			for (const variant of this.path.variants(id)) {
				const mods = g.getModulesByFile(variant)
				if (mods?.size) {
					for (const m of mods) {
						g.invalidateModule(m)
						viteInvalidated++
					}
				} else {
					const m = g.getModuleById(variant)
					if (m) {
						g.invalidateModule(m)
						viteInvalidated++
					}
				}
			}
		}

		const { invalidated: runnerInvalidated, invalidatedKeys } =
			this.runner.invalidateRunnerCacheByFiles(affectedIds)

		const dbg = this.dbg.cache
		if (!dbg) return
		dbg('invalidated: vite=%n runner=%n', viteInvalidated, runnerInvalidated)
		if (invalidatedKeys.length) dbg('runner keys: %l', invalidatedKeys.map((k) => this.path.pretty(k)))
	}
}
