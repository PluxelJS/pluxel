import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Logger as LogtapeLogger } from '@logtape/logtape'
import { type Context as PluxelContext, Injectable } from '@pluxel/core'
import { getDebugLogger } from '@pluxel/core/logger'
import { resolveModuleIdBaseDir, findRuntimeModuleId } from '@pluxel/runtime/internal'
import { watch, type FSWatcher } from 'chokidar'
import { dirname, isAbsolute, join, resolve } from 'pathe'
import { collectModuleGraphFiles } from './moduleGraph'

const serviceName = 'bundlerService' as const

declare module '@pluxel/core' {
	namespace Context {
		interface Services {
			[serviceName]: BundlerService
		}
	}
}

export interface BundlerServiceConfig {
	outDir?: string
	enabled?: boolean
}

export type BundleJob = {
	/** Optional label to improve diagnostics (e.g. plugin name). */
	label?: string
	/** "browser" bundles are validated to not import Node-only modules. */
	target?: 'browser' | 'node'
	entry: string
	root: string
	resolve: unknown
	external?: string[]
	/**
	 * Optional cache key for disk caching.
	 * If omitted, bundling is still performed but no disk cache is used
	 * (because this service cannot reliably infer dependency graphs).
	 */
	cacheKey?: string
}

export type BundleResult = {
	code: string
	hash: string
}

export type TinypoolWorkerOwnerContext = Pick<PluxelContext, 'loader' | 'pluginInfo' | 'registry'>

export type TinypoolWorkerCompileOptions = {
	external?: string[]
	vite?: import('vite').ViteDevServer
}

export type TinypoolWorkerWatchOptions = TinypoolWorkerCompileOptions & {
	onUpdate: (workerUrl: string) => void | Promise<void>
	onError?: (error: unknown) => void
}

const WATCHER_IGNORED_GLOBS = [
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

/**
 * Runs Vite's `build()` inside a Tinypool worker.
 *
 * Intended uses:
 * - `ExtensionCompilerService`: HMR-bundle plugin UI entries into a single ESM module for the browser.
 * - Plugins: optionally bundle TS/ESM into a `.mjs` file (via `cacheKey` + `getBundleFileUrl`) and pass it to `tinypool`.
 */
@Injectable({ key: serviceName })
export class BundlerService {
	private readonly dbg: LogtapeLogger
	private readonly enabled: boolean
	private readonly outDir: string

	constructor(
		public ctx: PluxelContext,
		config?: BundlerServiceConfig,
	) {
		const logger = (this.ctx as unknown as { logger?: unknown }).logger
		const fn =
			logger && typeof logger === 'object'
				? (logger as Record<string, unknown>).getDebugChannel
				: undefined
		this.dbg =
			typeof fn === 'function'
				? (fn as (t: string) => LogtapeLogger).call(logger, 'pluxel:bundler')
				: getDebugLogger('pluxel:bundler').with({
						name: 'bundler',
						context: this.ctx?.name ?? 'hmr',
					})
		this.enabled = config?.enabled !== false
		this.outDir = config?.outDir ?? resolve(process.cwd(), '.pluxel/bundles')
	}

	async bundle(job: BundleJob): Promise<BundleResult> {
		if (!this.enabled) {
			throw new Error('BundlerService disabled')
		}

		const cacheKey = job.cacheKey?.trim() || null
		const cachedFile = cacheKey ? join(this.outDir, `${cacheKey}.mjs`) : null
		if (cachedFile && existsSync(cachedFile)) {
			const code = await readFile(cachedFile, 'utf-8')
			return { code, hash: cacheKey }
		}

		const signature = cacheKey ? null : await this.computeSignature(job)
		const pool = this.getPool()
		this.dbg.debug('bundle start {entry}', { entry: job.entry })
		const code = await pool.run({
			label: job.label,
			target: job.target,
			entry: job.entry,
			root: job.root,
			resolve: job.resolve,
			external: job.external ?? [],
		})
		if (cachedFile) {
			await mkdir(this.outDir, { recursive: true })
			await writeFile(cachedFile, code, 'utf-8')
		}
		this.dbg.debug('bundle done {entry}', { entry: job.entry })
		return { code, hash: cacheKey ?? signature! }
	}

	/**
	 * Bundles a TS/ESM entry to an on-disk `.mjs` module and returns its `file:` URL,
	 * suitable for `new Tinypool({ filename })`.
	 *
	 * Notes:
	 * - Resolves `tsEntry` relative to the current plugin directory when possible.
	 * - Computes a cacheKey using Vite's module graph so edits to local dependencies
	 *   invalidate the cached file.
	 */
	async compileTinypoolWorker(
		ownerCtx: TinypoolWorkerOwnerContext,
		tsEntry: string,
		opts?: TinypoolWorkerCompileOptions,
	): Promise<string> {
		const vite = opts?.vite
		if (!vite) {
			throw new Error('ViteDevServer not provided (required for compileTinypoolWorker)')
		}

		// Workers are executed in Node (Tinypool), so use the SSR environment for resolution and dependency keys.
		const ssrEnv = vite.environments?.ssr
		if (!ssrEnv) {
			throw new Error(
				'ViteDevServer SSR environment not available (required for compileTinypoolWorker)',
			)
		}

		const absoluteEntry = this.resolveEntryForContext(ownerCtx, tsEntry)
		const url = this.toViteUrl(absoluteEntry, ssrEnv.config.root)
		const cacheKey = await this.computeViteModuleGraphKey(url, ssrEnv, {
			external: opts?.external ?? [],
		})

		const result = await this.bundle({
			target: 'node',
			entry: absoluteEntry,
			root: ssrEnv.config.root,
			resolve: ssrEnv.config.resolve,
			external: opts?.external ?? [],
			cacheKey: `worker-${cacheKey}`,
		})
		return this.getBundleFileUrl(result.hash)
	}

	async watchTinypoolWorker(
		ownerCtx: TinypoolWorkerOwnerContext,
		tsEntry: string,
		opts: TinypoolWorkerWatchOptions,
	): Promise<() => Promise<void>> {
		const vite = opts.vite
		if (!vite) {
			throw new Error('ViteDevServer not provided (required for watchTinypoolWorker)')
		}

		let disposed = false
		let watcher: FSWatcher | null = null
		let watchSignature = ''
		let lastUrl: string | null = null
		let running = false
		let rerunRequested = false

		const closeWatcher = async (): Promise<void> => {
			const active = watcher
			watcher = null
			watchSignature = ''
			if (!active) return
			await active.close().catch((): undefined => undefined)
		}

		const refreshWatcher = async (): Promise<void> => {
			const files = await this.collectTinypoolWorkerFiles(ownerCtx, tsEntry, vite)
			if (disposed) return

			const nextSignature = files.join('\n')
			if (nextSignature === watchSignature) return

			await closeWatcher()
			if (files.length === 0 || disposed) return

			watchSignature = nextSignature
			const nextWatcher = watch(files, {
				ignoreInitial: true,
				awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
				ignored: WATCHER_IGNORED_GLOBS,
			})
			const schedule = () => {
				void run()
			}
			nextWatcher.on('change', schedule)
			nextWatcher.on('unlink', schedule)
			nextWatcher.on('add', schedule)
			watcher = nextWatcher
		}

		const run = async (): Promise<void> => {
			if (disposed) return
			if (running) {
				rerunRequested = true
				return
			}

			running = true
			try {
				do {
					rerunRequested = false
					try {
						const workerUrl = await this.compileTinypoolWorker(ownerCtx, tsEntry, {
							external: opts.external,
							vite,
						})
						await refreshWatcher()
						if (disposed || workerUrl === lastUrl) continue
						lastUrl = workerUrl
						await opts.onUpdate(workerUrl)
					} catch (error) {
						opts.onError?.(error)
					}
				} while (rerunRequested && !disposed)
			} finally {
				running = false
			}
		}

		await run()

		return async () => {
			disposed = true
			await closeWatcher()
		}
	}

	getBundleFileUrl(hash: string): string {
		return pathToFileURL(join(this.outDir, `${hash}.mjs`)).href
	}

	async dispose(): Promise<void> {
		const pool = this.pool
		this.pool = null
		if (!pool) return
		await pool.destroy().catch((): undefined => undefined)
	}

	private async computeSignature(job: BundleJob): Promise<string> {
		const hash = createHash('sha256')
		hash.update('bundler:1')
		hash.update(job.entry)
		hash.update(job.root)
		hash.update(JSON.stringify(job.external ?? []))
		// resolve 里可能包含函数/循环引用；失败就跳过（仍然能靠 entry 内容变化触发更新）
		try {
			hash.update(JSON.stringify(job.resolve ?? null))
		} catch {
			// ignore non-serializable resolve options
		}
		try {
			const content = await readFile(job.entry, 'utf-8')
			hash.update(content)
		} catch {
			// ignore entry read errors; hash will still include entry path and other fields
		}
		return hash.digest('hex').slice(0, 16)
	}

	private pool: import('tinypool').default | null = null
	private getPool(): import('tinypool').default {
		if (this.pool) return this.pool
		// 延迟创建，避免未用时初始化线程
		const { default: Tinypool } = require('tinypool') as typeof import('tinypool')
		const worker = this.resolveWorkerPath()
		const cpuSlack = Math.max(1, require('node:os').cpus().length - 1)
		this.pool = new Tinypool({
			filename: worker,
			// Default: keep 1 warm worker, burst to 1-2 workers, and shrink back to 1.
			minThreads: 1,
			maxThreads: Math.min(2, cpuSlack),
			// Allow extra workers to be reclaimed when idle (won't go below minThreads).
			idleTimeout: 10_000,
		})
		return this.pool
	}

	private resolveWorkerPath(): string {
		const currentDir = dirname(fileURLToPath(import.meta.url))
		const pkgRoot = resolve(currentDir, '../../..')
		const candidates = [
			pathToFileURL(resolve(pkgRoot, 'dist/bundle-worker.mjs')).href, // copied by tsdown
			pathToFileURL(join(currentDir, 'bundle-worker.mjs')).href, // same dir as compiled chunk
			pathToFileURL(resolve(pkgRoot, 'src/hmr/compile/bundler/bundle-worker.mjs')).href, // source fallback
		]
		for (const href of candidates) {
			try {
				if (existsSync(fileURLToPath(href))) {
					return href
				}
			} catch {
				// ignore invalid file URLs
			}
		}
		return candidates.at(-1)!
	}

	private resolveEntryForContext(ownerCtx: TinypoolWorkerOwnerContext, tsEntry: string): string {
		if (isAbsolute(tsEntry)) return tsEntry
		const pluginId = ownerCtx.pluginInfo?.id
		if (pluginId) {
			try {
				const registryPath = findRuntimeModuleId(ownerCtx, pluginId)
				const baseDir = registryPath ? resolveModuleIdBaseDir(registryPath) : null
				if (baseDir) {
					return resolve(baseDir, tsEntry)
				}
			} catch {
				// ignore registry errors and fall back to cwd
			}
		}
		return resolve(process.cwd(), tsEntry)
	}

	private async collectTinypoolWorkerFiles(
		ownerCtx: TinypoolWorkerOwnerContext,
		tsEntry: string,
		vite: import('vite').ViteDevServer,
	): Promise<string[]> {
		const absoluteEntry = this.resolveEntryForContext(ownerCtx, tsEntry)
		const ssrEnv = vite.environments?.ssr
		if (!ssrEnv) return [absoluteEntry]

		const url = this.toViteUrl(absoluteEntry, ssrEnv.config.root)
		try {
			await ssrEnv.transformRequest(url)
			const rootModule = await ssrEnv.moduleGraph.getModuleByUrl(url)
			if (!rootModule) return [absoluteEntry]
			return collectModuleGraphFiles(rootModule as any)
		} catch {
			return [absoluteEntry]
		}
	}

	private toViteUrl(absoluteFile: string, viteRoot: string): string {
		let url = absoluteFile
		if (url.startsWith(viteRoot)) {
			url = url.slice(viteRoot.length)
		}
		if (!url.startsWith('/')) url = '/' + url
		return url
	}

	private async computeViteModuleGraphKey(
		url: string,
		env: Pick<import('vite').DevEnvironment, 'config' | 'moduleGraph' | 'transformRequest'>,
		opts: { external: string[] },
	): Promise<string> {
		const hash = createHash('sha256')
		hash.update('worker-graph:1')
		hash.update(url)
		hash.update(opts.external.join('|'))

		try {
			await env.transformRequest(url)
			const rootModule = await env.moduleGraph.getModuleByUrl(url)
			if (rootModule) {
				const files = collectModuleGraphFiles(rootModule as any)
				for (const file of files) {
					hash.update(file)
					try {
						hash.update(await readFile(file, 'utf-8'))
					} catch {
						// ignore unreadable files; key still includes their paths
					}
				}
			}
		} catch {
			// fall back to entry-only key
		}

		return hash.digest('hex').slice(0, 16)
	}
}
