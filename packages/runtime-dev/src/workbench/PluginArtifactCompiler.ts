import { createHash } from 'node:crypto'
import { existsSync, type Dirent } from 'node:fs'
import { readdir, readFile, rm, stat } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { pluginDefinitionIndexKey, type Context, type NodeModuleDeclaration } from '@pluxel/runtime'
import {
	readNodeModuleDeclaration,
	type NodeModuleSourceSubscription,
	type WorkbenchArtifactRevision,
	type WorkbenchArtifactService,
} from '@pluxel/runtime/internal'
import {
	WORKBENCH_FEDERATION_MANIFEST_FILE,
	type WorkbenchFederationProducerPlan,
} from '@pluxel/core/federation'
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
}>

export type PluginArtifactCompilerViteServer = {
	config: Pick<ViteDevServer['config'], 'root'>
	environments?: ViteDevServer['environments']
}

export type PluginArtifactCompilerWorkbenchStore = Pick<
	WorkbenchArtifactService,
	'commitCandidate' | 'getCurrent'
>

export type PluginArtifactCompilerDeps = Readonly<{
	store?: PluginArtifactCompilerWorkbenchStore
	viteServer?: PluginArtifactCompilerViteServer
}>

export type WorkbenchProducerCompilation = Readonly<{
	plan: WorkbenchFederationProducerPlan
	/** Package/application root against which generated Bridge entries are resolved. */
	root: string
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

const ARTIFACT_BUILD_CONCURRENCY = 2
const ARTIFACT_CACHE_KEEP = 5

/**
 * Route-neutral development artifact compiler.
 *
 * Workbench plans come only from the shared semantic lowering pass. This class never
 * rediscovers renderer declarations or computes a second source hash/build revision.
 * Node modules retain their independent source watcher because their declaration is a
 * runtime-consumed artifact primitive rather than a Workbench publication.
 */
export class PluginArtifactCompiler {
	private readonly store?: PluginArtifactCompilerWorkbenchStore
	private readonly viteServer?: PluginArtifactCompilerViteServer
	private readonly cacheDir: string
	private readonly producerTasks = new Map<string, Promise<WorkbenchArtifactRevision | null>>()
	private readonly desiredProducerByDefinition = new Map<string, string>()
	private readonly nodeEntries = new Map<string, NodeModuleCompileEntry>()
	private activeBuilds = 0
	private readonly buildWaiters: Array<() => void> = []
	private readonly signal = new AbortController()

	constructor(
		public ctx: Context,
		deps: PluginArtifactCompilerDeps,
		options?: PluginArtifactCompilerOptions,
	) {
		this.store = deps.store
		this.viteServer = deps.viteServer
		this.cacheDir = resolve(options?.cacheDir ?? resolve(process.cwd(), '.pluxel/plugin-artifacts'))
	}

	/**
	 * Builds, validates, and commits one immutable producer revision.
	 *
	 * A newer plan for the same Plugin definition supersedes an in-flight older build.
	 * The stale candidate may finish in the disk cache but cannot enter the inventory.
	 */
	async publishWorkbenchProducer(
		input: WorkbenchProducerCompilation,
	): Promise<WorkbenchArtifactRevision | null> {
		const store = this.store
		if (!store) throw new Error('[runtime-dev] Workbench compiler is not attached')
		const root = resolveProducerRoot(input.root)
		const plan = input.plan
		assertSafeProducerReference(plan)
		const definitionKey = pluginDefinitionIndexKey(plan.definition)
		const reference = producerReference(plan)
		this.desiredProducerByDefinition.set(definitionKey, reference)
		const current = store.getCurrent(plan.definition)
		if (current?.producer === plan.producer && current.buildRevision === plan.buildRevision) {
			return current
		}

		const taskKey = producerTaskKey(plan, root)
		const existing = this.producerTasks.get(taskKey)
		if (existing) return existing
		const task = this.performProducerBuild(plan, root, definitionKey, reference)
		this.producerTasks.set(taskKey, task)
		try {
			return await task
		} finally {
			if (this.producerTasks.get(taskKey) === task) this.producerTasks.delete(taskKey)
		}
	}

	async publishWorkbenchProducers(
		inputs: readonly WorkbenchProducerCompilation[],
	): Promise<readonly (WorkbenchArtifactRevision | null)[]> {
		return Promise.all(inputs.map((input) => this.publishWorkbenchProducer(input)))
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
		this.desiredProducerByDefinition.clear()
		for (const entry of this.nodeEntries.values()) {
			entry.active = false
			this.disposeNodeWatcher(entry)
			entry.listeners.clear()
		}
		this.nodeEntries.clear()
	}

	private async performProducerBuild(
		plan: WorkbenchFederationProducerPlan,
		root: string,
		definitionKey: string,
		reference: string,
	): Promise<WorkbenchArtifactRevision | null> {
		const store = this.store!
		const outDir = join(this.cacheDir, 'workbench', plan.producer, plan.buildRevision)
		await this.withBuildSlot(async () => {
			const { buildWorkbenchFederationProducer } =
				await import('@pluxel/rolldown/vite/workbench-ui')
			await buildWorkbenchFederationProducer({
				plan,
				root,
				outDir,
				minify: false,
				sourcemap: true,
				signal: this.signal.signal,
			})
		})
		if (
			this.signal.signal.aborted ||
			this.desiredProducerByDefinition.get(definitionKey) !== reference
		) {
			return null
		}
		const committed = await store.commitCandidate({ plan, artifactRoot: outDir })
		await this.cleanupProducerCache(plan.producer, committed.buildRevision)
		return committed
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
					await this.withBuildSlot(async () => {
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

	private async withBuildSlot<T>(build: () => Promise<T>): Promise<T> {
		if (this.activeBuilds >= ARTIFACT_BUILD_CONCURRENCY) {
			await new Promise<void>((resolveSlot) => this.buildWaiters.push(resolveSlot))
		}
		this.activeBuilds += 1
		try {
			return await build()
		} finally {
			this.activeBuilds -= 1
			this.buildWaiters.shift()?.()
		}
	}
}

function resolveProducerRoot(input: unknown): string {
	if (typeof input !== 'string' || !input || !isAbsolute(input)) {
		throw new TypeError('[runtime-dev] Workbench producer root must be an absolute path')
	}
	return resolve(input)
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
