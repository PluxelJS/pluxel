import { createHash, randomUUID } from 'node:crypto'
import { existsSync, type Dirent } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { pluginDefinitionIndexKey, type Context, type NodeModuleDeclaration } from '@pluxel/runtime'
import {
	readNodeModuleDeclaration,
	type NodeModuleSourceSubscription,
	type WorkbenchArtifactBatchCommit,
	type WorkbenchArtifactCandidate,
	type WorkbenchArtifactCoordinator,
	type WorkbenchPageArtifactCandidate,
} from '@pluxel/runtime/internal'
import {
	WORKBENCH_FEDERATION_MANIFEST_FILE,
	type WorkbenchFederationProducerPlan,
} from '@pluxel/core/federation'
import {
	WORKBENCH_PAGE_ARTIFACT_FILE,
	parseWorkbenchPageSet,
	serializeWorkbenchPageDefinition,
	serializeWorkbenchPageSet,
	type WorkbenchPageSetV1,
} from '@pluxel/core/internal'
import { collectSourceGraphFiles } from '@pluxel/rolldown/vite/source-graph'
import {
	resolveNodeModuleArtifactKey,
	resolveNodeModuleBuildSignature,
} from '@pluxel/rolldown/vite/declaration'
import { watch, type FSWatcher } from 'chokidar'
import { isAbsolute, join, resolve } from 'pathe'
import type { ViteDevServer } from 'vite'

export type PluginArtifactCompilerOptions = Readonly<{
	/** Disk cache root. @defaultValue `.pluxel/plugin-artifacts` under `process.cwd()`. */
	cacheDir?: string
	/** Package export graph used by Workbench producers. */
	packageMode: 'development' | 'distribution'
}>

export type PluginArtifactCompilerViteServer = {
	config: Pick<ViteDevServer['config'], 'root'>
	environments?: ViteDevServer['environments']
	watcher?: Pick<ViteDevServer['watcher'], 'add'>
}

export type PluginArtifactCompilerWorkbenchCoordinator = Pick<
	WorkbenchArtifactCoordinator,
	'commitCandidate'
>

export type PluginArtifactCompilerDeps = Readonly<{
	coordinator?: PluginArtifactCompilerWorkbenchCoordinator
	viteServer?: PluginArtifactCompilerViteServer
}>

export type WorkbenchProducerCompilation = Readonly<{
	plan: WorkbenchFederationProducerPlan
	/** Package root against which generated Bridge entries and dependencies are resolved. */
	root: string
}>

export type WorkbenchPageCompilation = Readonly<{
	pageSet: WorkbenchPageSetV1
	digest: string
	bytes: Uint8Array
	/** Package root containing the Markdown source or packaged Page artifact. */
	root: string
	sources: readonly string[]
}>

export type WorkbenchArtifactCompilations = Readonly<{
	producers: readonly WorkbenchProducerCompilation[]
	pages: readonly WorkbenchPageCompilation[]
}>

type WorkbenchDefinitionCompilation = {
	definition: WorkbenchFederationProducerPlan['definition']
	producer?: WorkbenchProducerCompilation
	page?: WorkbenchPageCompilation
}

type WorkbenchDefinitionCandidate = Readonly<{
	definition: WorkbenchFederationProducerPlan['definition']
	federation?: WorkbenchArtifactCandidate
	pages?: WorkbenchPageArtifactCandidate
}>

type NodeModuleListener = {
	onUpdate: (url: URL) => void | Promise<void>
	onError: (error: unknown) => void
}

type NodeModuleCompileEntry = {
	key: string
	entryPath: string
	sourceFiles: string[]
	listeners: Set<NodeModuleListener>
	watcher?: FSWatcher | null
	activeUrl?: URL
	active: boolean
	dirty: boolean
	compileTask?: Promise<void>
}

const WATCHER_IGNORED_GLOBS: string[] = [
	'**/node_modules/**',
	'**/.git/**',
	'**/.turbo/**',
	'**/.pluxel/**',
	'**/dist/**',
	'**/build/**',
	'**/.*',
	'**/*.swp',
	'**/*.swo',
	'**/*.tmp',
	'**/*~',
]

const HASH_IGNORED_SEGMENTS = [
	'node_modules',
	'.git',
	'.turbo',
	'.pluxel',
	'dist',
	'build',
	'.next',
] as const

const HASH_ALLOWED_EXTENSIONS = [
	'.ts',
	'.tsx',
	'.js',
	'.jsx',
	'.mjs',
	'.cjs',
	'.css',
	'.scss',
	'.sass',
	'.less',
	'.json',
] as const

const NODE_ARTIFACT_BUILD_CONCURRENCY = 2
const ARTIFACT_CACHE_KEEP = 5
const SHA256 = /^[a-f\d]{64}$/

/**
 * Route-neutral development artifact compiler.
 *
 * Workbench plans come only from the shared semantic lowering pass. This class never
 * rediscovers renderer declarations or computes a second source hash/build revision.
 * Node modules retain their independent source watcher because their declaration is a
 * runtime-consumed artifact primitive rather than a Workbench publication.
 */
export class PluginArtifactCompiler {
	private readonly coordinator?: PluginArtifactCompilerWorkbenchCoordinator
	private readonly viteServer?: PluginArtifactCompilerViteServer
	private readonly cacheDir: string
	private readonly packageMode: 'development' | 'distribution'
	private readonly producerTasks = new Map<string, Promise<WorkbenchArtifactCandidate>>()
	private readonly producerCandidates = new Map<string, WorkbenchArtifactCandidate>()
	private readonly committedWorkbenchDefinitions = new Map<
		string,
		WorkbenchFederationProducerPlan['definition']
	>()
	private workbenchPublicationEpoch = 0
	private workbenchCommitTail: Promise<void> = Promise.resolve()
	private readonly nodeEntries = new Map<string, NodeModuleCompileEntry>()
	private activeNodeBuilds = 0
	private readonly nodeBuildWaiters: Array<() => void> = []
	private readonly signal = new AbortController()

	constructor(
		public ctx: Context,
		deps: PluginArtifactCompilerDeps,
		options: PluginArtifactCompilerOptions,
	) {
		this.coordinator = deps.coordinator
		this.viteServer = deps.viteServer
		this.cacheDir = resolve(options.cacheDir ?? resolve(process.cwd(), '.pluxel/plugin-artifacts'))
		this.packageMode = options.packageMode
	}

	/**
	 * Materializes one semantic snapshot, then commits each definition's complete desired tuple.
	 * A newer snapshot supersedes older in-flight materialization before it can commit.
	 */
	async publishWorkbenchArtifacts(
		input: WorkbenchArtifactCompilations,
	): Promise<readonly WorkbenchArtifactBatchCommit[]> {
		const coordinator = this.coordinator
		if (!coordinator) throw new Error('[runtime-dev] Workbench compiler is not attached')
		const epoch = ++this.workbenchPublicationEpoch
		const definitions = groupWorkbenchCompilations(input)
		const materialized = await Promise.all(
			[...definitions.entries()].map(async ([key, compilation]) => {
				const [federation, pages] = await Promise.all([
					compilation.producer ? this.materializeProducer(compilation.producer) : undefined,
					compilation.page ? this.materializePage(compilation.page) : undefined,
				])
				return [
					key,
					Object.freeze({ definition: compilation.definition, federation, pages }),
				] as const
			}),
		)
		if (this.signal.signal.aborted || epoch !== this.workbenchPublicationEpoch) return []
		const candidates = new Map(materialized)
		return this.withWorkbenchCommit(async () => {
			if (this.signal.signal.aborted || epoch !== this.workbenchPublicationEpoch) return []
			const desired = new Map(this.committedWorkbenchDefinitions)
			for (const [key, compilation] of definitions) desired.set(key, compilation.definition)
			const commits: WorkbenchArtifactBatchCommit[] = []
			for (const [key, definition] of [...desired].sort(([left], [right]) =>
				left.localeCompare(right),
			)) {
				if (this.signal.signal.aborted || epoch !== this.workbenchPublicationEpoch) break
				const candidate = candidates.get(key)
				const commit = await coordinator.commitCandidate(candidate ?? Object.freeze({ definition }))
				commits.push(commit)
				if (candidate) this.committedWorkbenchDefinitions.set(key, definition)
				else this.committedWorkbenchDefinitions.delete(key)
			}
			await this.cleanupWorkbenchCandidates(candidates.values())
			return Object.freeze(commits)
		})
	}

	async watchNodeModule(
		declaration: NodeModuleDeclaration,
		onUpdate: (url: URL) => void | Promise<void>,
		onError: (error: unknown) => void,
	): Promise<NodeModuleSourceSubscription> {
		const descriptor = readNodeModuleDeclaration(declaration)
		const declarationFile = fileURLToPath(descriptor.moduleUrl)
		const entryPath = fileURLToPath(new URL(descriptor.entryPath, descriptor.moduleUrl))
		const root = resolve(this.viteServer?.config.root ?? process.cwd())
		const key =
			descriptor.artifactKey ??
			resolveNodeModuleArtifactKey(root, declarationFile, descriptor.entryPath)
		const listener: NodeModuleListener = { onUpdate, onError }
		let entry = this.nodeEntries.get(key)
		if (entry && entry.entryPath !== entryPath) {
			throw new Error(`[runtime-dev] Node module declaration key collision: ${key}`)
		}
		if (!entry) {
			entry = {
				key,
				entryPath,
				sourceFiles: [entryPath],
				listeners: new Set(),
				active: true,
				dirty: true,
				watcher: null,
			}
			this.nodeEntries.set(key, entry)
		}
		entry.listeners.add(listener)
		try {
			if (!entry.activeUrl) await this.compileNodeEntry(entry, true)
			const url = entry.activeUrl
			if (!url) throw new Error(`[runtime-dev] Node module build produced no artifact: ${key}`)
			let active = true
			return {
				url,
				dispose: async () => {
					if (!active) return
					active = false
					entry!.listeners.delete(listener)
					if (entry!.listeners.size > 0) return
					entry!.active = false
					this.disposeNodeWatcher(entry!)
					if (this.nodeEntries.get(key) === entry) this.nodeEntries.delete(key)
				},
			}
		} catch (error) {
			entry.listeners.delete(listener)
			if (entry.listeners.size === 0) {
				entry.active = false
				this.disposeNodeWatcher(entry)
				this.nodeEntries.delete(key)
			}
			throw error
		}
	}

	dispose(): void {
		this.signal.abort(new Error('[runtime-dev] artifact compiler disposed'))
		this.workbenchPublicationEpoch += 1
		this.committedWorkbenchDefinitions.clear()
		this.producerCandidates.clear()
		for (const entry of this.nodeEntries.values()) {
			entry.active = false
			this.disposeNodeWatcher(entry)
			entry.listeners.clear()
		}
		this.nodeEntries.clear()
	}

	private async materializeProducer(
		input: WorkbenchProducerCompilation,
	): Promise<WorkbenchArtifactCandidate> {
		const root = resolveProducerRoot(input.root)
		const plan = input.plan
		assertSafeProducerReference(plan)
		const taskKey = producerTaskKey(plan, root)
		const cached = this.producerCandidates.get(taskKey)
		if (cached && existsSync(join(cached.artifactRoot, WORKBENCH_FEDERATION_MANIFEST_FILE))) {
			return cached
		}
		const existing = this.producerTasks.get(taskKey)
		if (existing) return existing
		const task = this.performProducerBuild(plan, root).then((candidate) => {
			this.producerCandidates.set(taskKey, candidate)
			return candidate
		})
		this.producerTasks.set(taskKey, task)
		try {
			return await task
		} finally {
			if (this.producerTasks.get(taskKey) === task) this.producerTasks.delete(taskKey)
		}
	}

	private async performProducerBuild(
		plan: WorkbenchFederationProducerPlan,
		root: string,
	): Promise<WorkbenchArtifactCandidate> {
		const outDir = join(this.cacheDir, 'workbench', plan.producer, plan.buildRevision)
		const { buildWorkbenchFederationProducer } = await import('@pluxel/rolldown/vite/workbench-ui')
		await buildWorkbenchFederationProducer({
			plan,
			root,
			applicationRoot: this.viteServer?.config.root,
			packageMode: this.packageMode,
			outDir,
			minify: false,
			sourcemap: true,
			signal: this.signal.signal,
		})
		if (this.signal.signal.aborted) throw this.signal.signal.reason
		return Object.freeze({ plan, artifactRoot: outDir })
	}

	private async materializePage(
		input: WorkbenchPageCompilation,
	): Promise<WorkbenchPageArtifactCandidate> {
		resolvePageRoot(input.root)
		if (input.sources.length > 0) this.viteServer?.watcher?.add([...input.sources])
		const digest = parseSha256(input.digest, 'Page set digest')
		const bytes = Buffer.from(input.bytes)
		if (sha256(bytes) !== digest) {
			throw new TypeError('[runtime-dev] Workbench Page digest does not match its bytes')
		}
		let serialized: string
		try {
			serialized = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
		} catch (cause) {
			throw new TypeError('[runtime-dev] Workbench Page bytes are not valid UTF-8', { cause })
		}
		let pageSet: WorkbenchPageSetV1
		try {
			pageSet = parseWorkbenchPageSet(JSON.parse(serialized) as unknown)
		} catch (cause) {
			throw new TypeError('[runtime-dev] Workbench Page set is invalid', { cause })
		}
		if (
			serializeWorkbenchPageSet(pageSet) !== serialized ||
			serializeWorkbenchPageSet(input.pageSet) !== serialized
		) {
			throw new TypeError('[runtime-dev] Workbench Page bytes are not canonically serialized')
		}
		const definition = pageSet.definition
		const definitionDigest = sha256(serializeWorkbenchPageDefinition(definition))
		const artifactRoot = join(this.cacheDir, 'workbench-pages', definitionDigest, digest)
		await publishImmutablePageArtifact(artifactRoot, bytes, digest)
		return Object.freeze({ definition, definitionDigest, digest, artifactRoot })
	}

	private async cleanupWorkbenchCandidates(
		candidates: Iterable<WorkbenchDefinitionCandidate>,
	): Promise<void> {
		const tasks: Promise<void>[] = []
		for (const candidate of candidates) {
			if (candidate.federation) {
				tasks.push(
					this.cleanupProducerCache(
						candidate.federation.plan.producer,
						candidate.federation.plan.buildRevision,
					),
				)
			}
			if (candidate.pages) {
				tasks.push(this.cleanupPageCache(candidate.pages.definitionDigest, candidate.pages.digest))
			}
		}
		await Promise.all(tasks).catch((error) => {
			this.ctx.logger.warn('failed to clean Workbench artifact cache', { error })
		})
	}

	private async cleanupPageCache(definitionDigest: string, currentDigest: string): Promise<void> {
		const root = join(this.cacheDir, 'workbench-pages', definitionDigest)
		const names = await readdir(root).catch((): string[] => [])
		const revisions: Array<{ name: string; path: string; mtime: number }> = []
		for (const name of names) {
			if (!SHA256.test(name)) continue
			const path = join(root, name)
			const artifact = await stat(join(path, WORKBENCH_PAGE_ARTIFACT_FILE)).catch((): null => null)
			if (artifact?.isFile()) revisions.push({ name, path, mtime: artifact.mtimeMs })
		}
		revisions.sort((left, right) => right.mtime - left.mtime)
		const retained = new Set(
			[
				revisions.find((revision) => revision.name === currentDigest),
				...revisions.filter((revision) => revision.name !== currentDigest),
			]
				.filter((revision): revision is (typeof revisions)[number] => Boolean(revision))
				.slice(0, ARTIFACT_CACHE_KEEP)
				.map((revision) => revision.path),
		)
		for (const revision of revisions) {
			if (!retained.has(revision.path)) {
				await rm(revision.path, { recursive: true, force: true })
			}
		}
	}

	private withWorkbenchCommit<T>(commit: () => Promise<T>): Promise<T> {
		const task = this.workbenchCommitTail.then(commit, commit)
		this.workbenchCommitTail = task.then(
			(): void => undefined,
			(): void => undefined,
		)
		return task
	}

	private async compileNodeEntry(entry: NodeModuleCompileEntry, initial: boolean): Promise<void> {
		if (entry.compileTask) return entry.compileTask
		const task = this.performNodeCompile(entry, initial)
		entry.compileTask = task
		try {
			await task
		} finally {
			if (entry.compileTask === task) entry.compileTask = undefined
		}
	}

	private async performNodeCompile(entry: NodeModuleCompileEntry, initial: boolean): Promise<void> {
		do {
			entry.dirty = false
			try {
				await this.refreshNodeSourceFiles(entry)
				const sourceHash = await this.computeNodeSourceHash(entry)
				const outDir = join(this.cacheDir, 'node', entry.key)
				const outFile = join(outDir, `${sourceHash}.mjs`)
				const { buildNodeModule, validateNodeModuleArtifact } =
					await import('@pluxel/rolldown/vite/node-module')
				let reusable = existsSync(outFile)
				if (reusable) {
					try {
						await validateNodeModuleArtifact(outFile, {
							root: resolve(this.viteServer?.config.root ?? process.cwd()),
							entryPath: entry.entryPath,
						})
					} catch {
						reusable = false
						await rm(outFile, { force: true })
					}
				}
				if (!reusable) {
					await this.withNodeBuildSlot(async () => {
						if (!entry.active) return
						await buildNodeModule({
							root: resolve(this.viteServer?.config.root ?? process.cwd()),
							entryPath: entry.entryPath,
							outFile,
							minify: false,
						})
					})
				}
				if (!entry.active) return
				const nextUrl = pathToFileURL(outFile)
				const previous = entry.activeUrl?.href
				entry.activeUrl = nextUrl
				this.setupNodeWatcher(entry)
				await this.cleanupNodeCache(outDir, sourceHash)
				if (previous && previous !== nextUrl.href) {
					await Promise.all(
						[...entry.listeners].map((listener) =>
							Promise.resolve(listener.onUpdate(nextUrl)).catch(listener.onError),
						),
					)
				}
			} catch (error) {
				if (initial && !entry.activeUrl) throw error
				this.ctx.logger.error('failed to rebuild Node module', {
					artifactKey: entry.key,
					consumers: entry.listeners.size,
					error,
				})
				for (const listener of entry.listeners) {
					try {
						listener.onError(error)
					} catch (listenerError) {
						this.ctx.logger.error('failed to report Node module rebuild error', {
							artifactKey: entry.key,
							listenerError,
						})
					}
				}
			}
		} while (entry.active && entry.dirty)
	}

	private async refreshNodeSourceFiles(entry: NodeModuleCompileEntry): Promise<void> {
		const environment = this.viteServer?.environments?.ssr
		if (!environment) return
		let url = entry.entryPath
		const root = resolve(environment.config.root)
		if (url.startsWith(root)) url = url.slice(root.length)
		if (!url.startsWith('/')) url = `/${url}`
		await environment.transformRequest(url)
		const rootModule = await environment.moduleGraph.getModuleByUrl(url)
		if (!rootModule) return
		const files = collectSourceGraphFiles(rootModule)
		if (files.length > 0) entry.sourceFiles = files
	}

	private setupNodeWatcher(entry: NodeModuleCompileEntry): void {
		this.disposeNodeWatcher(entry)
		if (!entry.active || entry.sourceFiles.length === 0) return
		const watcher = watch(entry.sourceFiles, {
			ignoreInitial: true,
			awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
			ignored: WATCHER_IGNORED_GLOBS,
		})
		const invalidate = () => {
			if (!entry.active) return
			entry.dirty = true
			void this.compileNodeEntry(entry, false).catch((error) => {
				this.ctx.logger.error('failed to schedule Node module rebuild', {
					artifactKey: entry.key,
					error,
				})
			})
		}
		watcher.on('change', invalidate)
		watcher.on('unlink', invalidate)
		watcher.on('add', invalidate)
		entry.watcher = watcher
	}

	private disposeNodeWatcher(entry: NodeModuleCompileEntry): void {
		const watcher = entry.watcher
		entry.watcher = null
		if (watcher) void watcher.close().catch((): undefined => undefined)
	}

	private async cleanupNodeCache(dir: string, currentHash: string): Promise<void> {
		const files = await readdir(dir, { withFileTypes: true }).catch((): Dirent[] => [])
		const builds: Array<{ path: string; mtime: number }> = []
		for (const file of files) {
			if (!file.isFile() || file.name === `${currentHash}.mjs`) continue
			if (!/^[a-f\d]{16}\.mjs$/.test(file.name)) continue
			const path = join(dir, file.name)
			const info = await stat(path).catch((): null => null)
			if (info) builds.push({ path, mtime: info.mtimeMs })
		}
		builds.sort((a, b) => b.mtime - a.mtime)
		for (const stale of builds.slice(Math.max(0, ARTIFACT_CACHE_KEEP - 1))) {
			await rm(stale.path, { force: true })
		}
	}

	private async cleanupProducerCache(producer: string, currentRevision: string): Promise<void> {
		const root = join(this.cacheDir, 'workbench', producer)
		const names = await readdir(root).catch((): string[] => [])
		const builds: Array<{ name: string; path: string; mtime: number }> = []
		for (const name of names) {
			if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)) continue
			const path = join(root, name)
			const manifest = await stat(join(path, WORKBENCH_FEDERATION_MANIFEST_FILE)).catch(
				(): null => null,
			)
			if (manifest?.isFile()) builds.push({ name, path, mtime: manifest.mtimeMs })
		}
		builds.sort((left, right) => right.mtime - left.mtime)
		const retained = new Set(
			[
				builds.find((build) => build.name === currentRevision),
				...builds.filter((build) => build.name !== currentRevision),
			]
				.filter((build): build is (typeof builds)[number] => Boolean(build))
				.slice(0, ARTIFACT_CACHE_KEEP)
				.map((build) => build.path),
		)
		for (const build of builds) {
			if (!retained.has(build.path)) {
				await rm(build.path, { recursive: true, force: true })
			}
		}
	}

	private async computeNodeSourceHash(entry: NodeModuleCompileEntry): Promise<string> {
		const hash = createHash('sha256')
		hash.update('node-module-compiler:1')
		hash.update(entry.key)
		hash.update(resolveNodeModuleBuildSignature({ minify: false }))
		const files = await this.expandHashTargets(entry.sourceFiles)
		for (const file of files.sort()) {
			hash.update(file)
			hash.update(await readFile(file).catch(() => Buffer.alloc(0)))
		}
		return hash.digest('hex').slice(0, 16)
	}

	private async expandHashTargets(files: string[]): Promise<string[]> {
		const collected: string[] = []
		const visited = new Set<string>()
		const queue = [...files]
		for (const target of queue) {
			if (!target || visited.has(target)) continue
			visited.add(target)
			const info = await stat(target).catch((): null => null)
			if (!info) continue
			if (info.isDirectory()) {
				for (const entry of await readdir(target)) {
					if (entry.startsWith('.') || /(?:~|\.swp|\.swo|\.tmp)$/.test(entry)) continue
					const path = join(target, entry)
					if (hasIgnoredHashPathSegment(path)) continue
					const nested = await stat(path).catch((): null => null)
					if (!nested) continue
					if (nested.isDirectory()) queue.push(path)
					else if (isHashableSourceFile(path)) collected.push(path)
				}
			} else if (isHashableSourceFile(target)) {
				collected.push(target)
			}
		}
		return collected
	}

	private async withNodeBuildSlot<T>(build: () => Promise<T>): Promise<T> {
		if (this.activeNodeBuilds >= NODE_ARTIFACT_BUILD_CONCURRENCY) {
			await new Promise<void>((resolveSlot) => this.nodeBuildWaiters.push(resolveSlot))
		}
		this.activeNodeBuilds += 1
		try {
			return await build()
		} finally {
			this.activeNodeBuilds -= 1
			this.nodeBuildWaiters.shift()?.()
		}
	}
}

function resolveProducerRoot(input: unknown): string {
	if (typeof input !== 'string' || !input || !isAbsolute(input)) {
		throw new TypeError('[runtime-dev] Workbench producer root must be an absolute path')
	}
	return resolve(input)
}

function resolvePageRoot(input: unknown): string {
	if (typeof input !== 'string' || !input || !isAbsolute(input)) {
		throw new TypeError('[runtime-dev] Workbench Page root must be an absolute path')
	}
	return resolve(input)
}

function groupWorkbenchCompilations(
	input: WorkbenchArtifactCompilations,
): Map<string, WorkbenchDefinitionCompilation> {
	if (!input || !Array.isArray(input.producers) || !Array.isArray(input.pages)) {
		throw new TypeError('[runtime-dev] Workbench artifact compilations must contain arrays')
	}
	const definitions = new Map<string, WorkbenchDefinitionCompilation>()
	for (const producer of input.producers) {
		const definition = producer.plan.definition
		const key = pluginDefinitionIndexKey(definition)
		const current: WorkbenchDefinitionCompilation = definitions.get(key) ?? { definition }
		if (current.producer) {
			throw new TypeError(`[runtime-dev] duplicate Workbench producer definition: ${key}`)
		}
		current.producer = producer
		definitions.set(key, current)
	}
	for (const page of input.pages) {
		const definition = page.pageSet.definition
		const key = pluginDefinitionIndexKey(definition)
		const current: WorkbenchDefinitionCompilation = definitions.get(key) ?? { definition }
		if (current.page) {
			throw new TypeError(`[runtime-dev] duplicate Workbench Page definition: ${key}`)
		}
		current.page = page
		definitions.set(key, current)
	}
	return definitions
}

async function publishImmutablePageArtifact(
	artifactRoot: string,
	bytes: Uint8Array,
	digest: string,
): Promise<void> {
	const artifactPath = join(artifactRoot, WORKBENCH_PAGE_ARTIFACT_FILE)
	if (await validateExistingPageArtifact(artifactPath, bytes, digest)) return
	const parent = resolve(artifactRoot, '..')
	await mkdir(parent, { recursive: true })
	const temporaryRoot = `${artifactRoot}.tmp-${process.pid}-${randomUUID()}`
	await mkdir(temporaryRoot)
	try {
		await writeFile(join(temporaryRoot, WORKBENCH_PAGE_ARTIFACT_FILE), bytes, { flag: 'wx' })
		try {
			await rename(temporaryRoot, artifactRoot)
		} catch (error) {
			if (!['EEXIST', 'ENOTEMPTY'].includes(errorCode(error))) throw error
		}
	} finally {
		await rm(temporaryRoot, { recursive: true, force: true })
	}
	if (!(await validateExistingPageArtifact(artifactPath, bytes, digest))) {
		throw new Error(`[runtime-dev] immutable Workbench Page artifact collision: ${digest}`)
	}
}

async function validateExistingPageArtifact(
	artifactPath: string,
	expected: Uint8Array,
	digest: string,
): Promise<boolean> {
	const existing = await readFile(artifactPath).catch((error): null => {
		if (errorCode(error) === 'ENOENT') return null
		throw error
	})
	if (!existing) return false
	if (sha256(existing) !== digest || !existing.equals(Buffer.from(expected))) {
		throw new Error(`[runtime-dev] immutable Workbench Page artifact collision: ${digest}`)
	}
	return true
}

function parseSha256(input: unknown, label: string): string {
	if (typeof input !== 'string' || !SHA256.test(input)) {
		throw new TypeError(`[runtime-dev] ${label} must be a lowercase SHA-256 digest`)
	}
	return input
}

function sha256(input: Uint8Array | string): string {
	return createHash('sha256').update(input).digest('hex')
}

function errorCode(error: unknown): string {
	return error && typeof error === 'object' && 'code' in error
		? String((error as { code?: unknown }).code)
		: ''
}

function assertSafeProducerReference(plan: WorkbenchFederationProducerPlan): void {
	if (
		!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(plan?.producer) ||
		!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(plan?.buildRevision)
	) {
		throw new TypeError('[runtime-dev] Workbench producer plan has an unsafe reference')
	}
}

function producerReference(plan: WorkbenchFederationProducerPlan): string {
	return `${plan.producer}\0${plan.buildRevision}`
}

function producerTaskKey(plan: WorkbenchFederationProducerPlan, root: string): string {
	return [
		producerReference(plan),
		root,
		...plan.entries.map(
			(entry) =>
				`${entry.descriptor.kind}:${entry.descriptor.key}:${entry.expose}:${entry.bridgeEntryPath}`,
		),
	].join('\0')
}

function hasIgnoredHashPathSegment(filePath: string): boolean {
	const segments = filePath.replaceAll('\\', '/').toLowerCase().split('/')
	return HASH_IGNORED_SEGMENTS.some((segment) => segments.includes(segment))
}

function isHashableSourceFile(filePath: string): boolean {
	const lower = filePath.toLowerCase()
	if (hasIgnoredHashPathSegment(lower)) return false
	if (
		lower.endsWith('.d.ts') ||
		lower.endsWith('.d.mts') ||
		lower.endsWith('.d.cts') ||
		lower.endsWith('.map')
	) {
		return false
	}
	return HASH_ALLOWED_EXTENSIONS.some((extension) => lower.endsWith(extension))
}
