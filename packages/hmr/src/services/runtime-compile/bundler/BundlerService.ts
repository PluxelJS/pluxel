import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { type Context, Injectable } from '@pluxel/core'
import { createDebug } from 'obug'
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

/**
 * Runs Vite's `build()` inside a Tinypool worker.
 *
 * Intended uses:
 * - `ExtensionService`: runtime-bundle plugin UI entries into a single ESM module for the browser.
 * - Plugins: optionally bundle TS/ESM into a `.mjs` file (via `cacheKey` + `getBundleFileUrl`) and pass it to `tinypool`.
 */
@Injectable({ key: serviceName })
export class BundlerService {
	private readonly dbg = createDebug('pluxel:bundler')
	private readonly enabled: boolean
	private readonly outDir: string

	constructor(
		public ctx: Context,
		config?: BundlerServiceConfig,
	) {
		this.enabled = config?.enabled !== false
		this.outDir = config?.outDir ?? resolve(process.cwd(), '.pluxel/bundles')
	}

	async bundle(job: BundleJob): Promise<BundleResult> {
		if (!this.enabled) {
			throw new Error('BundlerService disabled')
		}

		const signature = await this.computeSignature(job)
		const cacheKey = job.cacheKey?.trim() || null
		const cachedFile = cacheKey ? join(this.outDir, `${cacheKey}.mjs`) : null
		if (cachedFile && existsSync(cachedFile)) {
			const code = await readFile(cachedFile, 'utf-8')
			return { code, hash: cacheKey }
		}

		const pool = this.getPool()
		this.dbg('bundle start %s', job.entry)
		const code = await pool.run({
			entry: job.entry,
			root: job.root,
			resolve: job.resolve,
			external: job.external ?? [],
		})
		if (cachedFile) {
			await mkdir(this.outDir, { recursive: true })
			await writeFile(cachedFile, code, 'utf-8')
		}
		this.dbg('bundle done %s', job.entry)
		return { code, hash: cacheKey ?? signature }
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
	async compileTinypoolWorker(tsEntry: string, opts?: { external?: string[] }): Promise<string> {
		const vite = this.ctx.hmrService.vite
		if (!vite) {
			throw new Error('ViteDevServer not available (required for compileTinypoolWorker)')
		}

		const absoluteEntry = this.resolveEntryForContext(tsEntry)
		const url = this.toViteUrl(absoluteEntry, vite.config.root)
		const cacheKey = await this.computeViteModuleGraphKey(url, vite, {
			external: opts?.external ?? [],
		})

		const result = await this.bundle({
			entry: absoluteEntry,
			root: vite.config.root,
			resolve: vite.config.resolve,
			external: opts?.external ?? [],
			cacheKey: `worker-${cacheKey}`,
		})
		return this.getBundleFileUrl(result.hash)
	}

	getBundleFileUrl(hash: string): string {
		return pathToFileURL(join(this.outDir, `${hash}.mjs`)).href
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
		} catch {}
		try {
			const content = await readFile(job.entry, 'utf-8')
			hash.update(content)
		} catch {}
		return hash.digest('hex').slice(0, 16)
	}

	private pool: import('tinypool').default | null = null
	private getPool(): import('tinypool').default {
		if (this.pool) return this.pool
		// 延迟创建，避免未用时初始化线程
		const { default: Tinypool } = require('tinypool') as typeof import('tinypool')
		const worker = this.resolveWorkerPath()
		const cpuSlack = Math.max(1, require('os').cpus().length - 1)
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
			pathToFileURL(resolve(pkgRoot, 'src/services/runtime-compile/bundler/bundle-worker.mjs')).href, // source fallback
		]
		for (const href of candidates) {
			try {
				if (existsSync(fileURLToPath(href))) {
					return href
				}
			} catch {}
		}
		return candidates[candidates.length - 1]!
	}

	private resolveEntryForContext(tsEntry: string): string {
		if (isAbsolute(tsEntry)) return tsEntry
		const pluginId = this.ctx.pluginInfo?.id
		if (pluginId) {
			try {
				const registryPath = this.ctx.loader?.api?.registry?.findModuleIdByName?.(pluginId)
				if (registryPath) {
					return resolve(dirname(registryPath), tsEntry)
				}
			} catch {}
		}
		return resolve(process.cwd(), tsEntry)
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
		vite: import('vite').ViteDevServer,
		opts: { external: string[] },
	): Promise<string> {
		const hash = createHash('sha256')
		hash.update('worker-graph:1')
		hash.update(url)
		hash.update(opts.external.join('|'))

		try {
			await vite.transformRequest(url)
			const rootModule = await vite.moduleGraph.getModuleByUrl(url)
			if (rootModule) {
				const files = collectModuleGraphFiles(rootModule)
				for (const file of files) {
					hash.update(file)
					try {
						hash.update(await readFile(file, 'utf-8'))
					} catch {}
				}
			}
		} catch {
			// fall back to entry-only key
		}

		return hash.digest('hex').slice(0, 16)
	}
}
