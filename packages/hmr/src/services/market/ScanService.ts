import { existsSync, readFileSync } from 'node:fs'
import fs, { readdir } from 'node:fs/promises'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { type Context, Injectable } from '@pluxel/core'
import { resolvePath as mllyResolvePath } from 'mlly'
import { isAbsolute, normalize, resolve as r } from 'pathe'
import { readPackageJSON } from 'pkg-types'
import { getAllTsFiles } from './utils'

const serviceName = 'scanService' as const
declare module '@pluxel/core' {
	interface Context {
		[serviceName]: ScanService
	}
	interface Config {
		[serviceName]?: ScanServiceConfig
	}
}

/* ──────────────── 配置 ──────────────── */

export interface ScanServiceConfig {
	/** 默认 exports 条件（可被 per-call 覆盖） */
	conditions?: string[]
	/** 失败时保守回退候选（相对包目录） */
	conservativeCandidates?: string[]
	/** 扫描时是否将 monorepo 根也当作包解析 */
	includeRoot?: boolean
	/** 跳过没有 name 的包（仅 monorepo 模式；默认 true） */
	skipUnnamed?: boolean
	/** 单目录：入口解析失败时是否兜底扫描 .ts（默认 true） */
	fallbackTsOnSingle?: boolean
	/** 并发批大小 */
	batchSize?: number
}

/* ──────────────── 返回类型（判别联合，可类型收缩） ──────────────── */

export type ResolutionSource = 'exports' | 'main' | 'module' | 'fallback'

export type EntryOk = {
	ok: true
	dir: string
	entry: string
	source: ResolutionSource
	tried: string[] // 记录保守候选尝试过的相对路径（便于 debug）
}

export type EntryErrCode = 'NO_PACKAGE_JSON' | 'NO_ENTRY' | 'FS_ERROR'

export type EntryErr = {
	ok: false
	dir: string
	code: EntryErrCode
	message: string
	tried?: string[]
}

export type EntryResult = EntryOk | EntryErr

export type RepoOk = EntryOk & {
	name: string
	manifestPath?: string
}

export type RepoErr = EntryErr & {
	name?: string
	manifestPath?: string
}

export type RepoResult = RepoOk | RepoErr

/** 单输入目录扫描结果（判别：kind） */
export type DirResult =
	| {
			kind: 'monorepo'
			root: string
			includedRoot: boolean
			/** name → 结果（ok 判别） */
			packages: Record<string, RepoResult>
	  }
	| {
			kind: 'single'
			dir: string
			/** 单目录：要么解析到入口，要么 .ts 兜底，要么报错（NO_TS_FILES/NO_ENTRY） */
			result:
				| EntryResult
				| { ok: false; code: 'NO_TS_FILES'; dir: string; message: string }
			/** 如果入口未找到而兜底扫描，列出此次扫描到的 .ts 文件 */
			files?: string[]
	  }

/** 汇总报告（多输入目录，保持输入顺序） */
export interface ScanReport {
	ok: true
	inputs: string[]
	results: DirResult[] // 一一对应 inputs
	entries: string[] // 所有解析成功的入口（monorepo 包 + 单目录入口）
	files: string[] // 所有“单目录兜底”扫描得到的 .ts
	errors: Array<{
		dir: string
		code: 'NO_TS_FILES' | 'UNREADABLE_DIR'
		message: string
	}> // 仅聚合“单目录兜底仍失败”等目录级错误
	stats: {
		monoRoots: number
		packages: number
		entries: number
		tsFiles: number
		durationMs: number
	}
}

/* ──────────────── 默认值 ──────────────── */

const DEFAULTS: Required<ScanServiceConfig> = {
	conditions: ['@pluxel/source', 'node', 'import'],
	conservativeCandidates: [
		'index.ts',
		'index.mts',
		'index.cts',
		'index.js',
		'index.mjs',
		'index.cjs',
		'src/index.ts',
		'dist/index.js',
	],
	includeRoot: false,
	skipUnnamed: true,
	fallbackTsOnSingle: true,
	batchSize: 8,
}

/* ──────────────── 小工具：并发限制器 ──────────────── */

function pLimit(concurrency: number) {
	let active = 0
	const queue: Array<() => void> = []
	const next = () => {
		active--
		queue.shift()?.()
	}
	return function run<T>(task: () => Promise<T>): Promise<T> {
		return new Promise((resolve, reject) => {
			const exec = () => {
				active++
				task().then(
					(v) => {
						resolve(v)
						next()
					},
					(e) => {
						reject(e)
						next()
					},
				)
			}
			if (active < concurrency) exec()
			else queue.push(exec)
		})
	}
}

/* ──────────────── Service 实现 ──────────────── */

@Injectable({ key: serviceName })
export class ScanService {
	private cfg: Required<ScanServiceConfig>
	/** 目录级缓存（含配置签名）→ DirResult */
	private dirCache = new Map<string, Promise<DirResult>>()
	/** 入口解析缓存（dir+conditions）→ EntryResult */
	private entryCache = new Map<string, Promise<EntryResult>>()

	constructor(_ctx: Context, _cfg?: ScanServiceConfig) {
		this.cfg = { ...DEFAULTS, ..._cfg }
	}

	/** 便捷版：直接拿到所有可执行入口（entries + 单目录兜底 ts 文件） */
	async scan(
		input: string | string[],
		overrides: Partial<ScanServiceConfig> = {},
	): Promise<string[]> {
		const rep = await this.scanReport(input, overrides)
		return Array.from(new Set([...rep.entries, ...rep.files])).map(normalize)
	}

	/** 强类型报告：可类型收缩、含分支来源、errors 聚合 */
	async scanReport(
		input: string | string[],
		overrides: Partial<ScanServiceConfig> = {},
	): Promise<ScanReport> {
		const t0 = Date.now()
		const cfg = { ...this.cfg, ...overrides }
		const inputs = (Array.isArray(input) ? input : [input]).map((d) =>
			normalize(isAbsolute(d) ? d : r(process.cwd(), d)),
		)

		const limit = pLimit(cfg.batchSize)
		const results = await Promise.all(
			inputs.map((d) => limit(() => this.scanOne(d, cfg))),
		)

		const entries: string[] = []
		const files: string[] = []
		const errors: ScanReport['errors'] = []
		let monoRoots = 0
		let packages = 0

		for (const res of results) {
			if (res.kind === 'monorepo') {
				monoRoots++
				for (const [, v] of Object.entries(res.packages)) {
					packages++
					if (v.ok) entries.push(v.entry)
					// 包级失败不进入 errors（errors 专注“目录级兜底仍失败”）
				}
			} else {
				const r1 = res.result
				if (r1.ok) {
					entries.push(r1.entry)
				} else if (r1.code === 'NO_TS_FILES') {
					errors.push({
						dir: res.dir,
						code: 'NO_TS_FILES',
						message: r1.message,
					})
				} else {
					// NO_ENTRY 之类：若有兜底 files 就放 files；没有则也算目录级错误
					if (res.files?.length) files.push(...res.files)
					else
						errors.push({
							dir: res.dir,
							code: 'UNREADABLE_DIR',
							message: r1.message,
						})
				}
				if (res.files?.length) files.push(...res.files)
			}
		}

		const durationMs = Date.now() - t0
		return {
			ok: true,
			inputs,
			results,
			entries: Array.from(new Set(entries)).map(normalize),
			files: Array.from(new Set(files)).map(normalize),
			errors,
			stats: {
				monoRoots,
				packages,
				entries: entries.length,
				tsFiles: files.length,
				durationMs,
			},
		}
	}

	/* ── per-dir 扫描（带缓存） ── */
	private async scanOne(
		dir: string,
		cfg: Required<ScanServiceConfig>,
	): Promise<DirResult> {
		const key = JSON.stringify([
			'dir',
			dir,
			cfg.conditions,
			cfg.includeRoot,
			cfg.skipUnnamed,
			cfg.fallbackTsOnSingle,
			cfg.conservativeCandidates,
		])
		const cached = this.dirCache.get(key)
		if (cached) return cached

		const p = (async () => {
			if (await this.isMonorepoRoot(dir)) {
				return this.scanMonorepo(dir, cfg)
			} else {
				return this.scanSingle(dir, cfg)
			}
		})().catch((e) => {
			this.dirCache.delete(key)
			throw e
		})

		this.dirCache.set(key, p)
		return p
	}

	/* ── 判定 monorepo 根 ── */
	private async isMonorepoRoot(dir: string): Promise<boolean> {
		const pkg = await this.safeReadPkg(dir)
		const hasWs =
			Array.isArray((pkg as any)?.workspaces) ||
			Array.isArray((pkg as any)?.workspaces?.packages)
		const hasPnpm = existsSync(r(dir, 'pnpm-workspace.yaml'))
		if (hasWs || hasPnpm) return true
		// 惯例目录也算（尽量少误报）
		for (const g of ['packages', 'apps']) {
			try {
				const st = await fs.stat(r(dir, g))
				if (st.isDirectory()) return true
			} catch {}
		}
		return false
	}

	/* ── monorepo：枚举子包 → 解析入口（含 includeRoot） ── */
	private async scanMonorepo(
		root: string,
		cfg: Required<ScanServiceConfig>,
	): Promise<DirResult> {
		const dirs = await this.enumerateWorkspaceDirs(root)
		if (cfg.includeRoot) dirs.unshift(root)

		const limit = pLimit(cfg.batchSize)
		const packages: Record<string, RepoResult> = {}

		await Promise.all(
			dirs.map((d) =>
				limit(async () => {
					const manifestPath = r(d, 'package.json')
					const pkg = await this.safeReadPkg(d)
					const name = pkg?.name
					if (!name && cfg.skipUnnamed) return

					const er = await this.resolveEntryDetailed(d, cfg)
					if (er.ok) {
						packages[name ?? `@unknown/${this.relName(root, d)}`] = {
							...er,
							name: name ?? `@unknown/${this.relName(root, d)}`,
							manifestPath: existsSync(manifestPath) ? manifestPath : undefined,
						}
					} else {
						packages[name ?? `@unknown/${this.relName(root, d)}`] = {
							...er,
							name: name ?? undefined,
							manifestPath: existsSync(manifestPath) ? manifestPath : undefined,
						}
					}
				}),
			),
		)

		return { kind: 'monorepo', root, includedRoot: !!cfg.includeRoot, packages }
	}

	/* ── 单目录：入口 → 兜底 TS → 错误 ── */
	private async scanSingle(
		dir: string,
		cfg: Required<ScanServiceConfig>,
	): Promise<DirResult> {
		const er = await this.resolveEntryDetailed(dir, cfg)
		if (er.ok) return { kind: 'single', dir, result: er }

		if (!cfg.fallbackTsOnSingle) {
			return { kind: 'single', dir, result: er }
		}

		const files = await getAllTsFiles([dir], {
			includeDts: false,
			followSymlinks: true,
			concurrency: Math.min((os.cpus()?.length ?? 4) * 2, 64),
		})

		if (files.length === 0) {
			return {
				kind: 'single',
				dir,
				result: {
					ok: false,
					code: 'NO_TS_FILES',
					dir,
					message:
						'No .ts files found in directory after entry resolution failed.',
				},
			}
		}

		return { kind: 'single', dir, result: er, files }
	}

	/* ── 入口解析（带来源、尝试路径；缓存） ── */
	private async resolveEntryDetailed(
		dir: string,
		cfg: Required<ScanServiceConfig>,
	): Promise<EntryResult> {
		const key = JSON.stringify([
			'entry',
			dir,
			cfg.conditions,
			cfg.conservativeCandidates,
		])
		const cached = this.entryCache.get(key)
		if (cached) return cached

		const p = (async (): Promise<EntryResult> => {
			try {
				const p = await mllyResolvePath('.', {
					url: pathToFileURL(dir),
					conditions: cfg.conditions,
				})
				return {
					ok: true,
					dir,
					entry: normalize(p),
					source: 'exports',
					tried: [],
				}
			} catch (_e: any) {
				// fallthrough
			}

			const pkg = await this.safeReadPkg(dir)
			const tried: string[] = []
			const cand: string[] = []

			if (!pkg) {
				// 仍尝试保守候选（package.json 丢失时 cand 仅 conservative）
				for (const rel of cfg.conservativeCandidates) {
					tried.push(rel)
					const abs = r(dir, rel)
					if (existsSync(abs))
						return {
							ok: true,
							dir,
							entry: normalize(abs),
							source: 'fallback',
							tried,
						}
				}
				return {
					ok: false,
					dir,
					code: 'NO_PACKAGE_JSON',
					message: 'package.json not found and no fallback candidates exist.',
					tried,
				}
			}

			if (pkg.main) {
				cand.push(pkg.main)
				tried.push(pkg.main)
			}
			if (pkg.module) {
				cand.push(pkg.module)
				tried.push(pkg.module)
			}
			cand.push(...cfg.conservativeCandidates.filter((x) => !cand.includes(x)))

			for (const rel of cand) {
				const abs = r(dir, rel)
				if (existsSync(abs)) {
					const src: ResolutionSource =
						rel === pkg.main
							? 'main'
							: rel === pkg.module
								? 'module'
								: 'fallback'
					return { ok: true, dir, entry: normalize(abs), source: src, tried }
				}
			}

			return {
				ok: false,
				dir,
				code: 'NO_ENTRY',
				message: 'No entry file resolved from exports/main/module/fallback.',
				tried,
			}
		})().catch((e: any): EntryErr => {
			return {
				ok: false,
				dir,
				code: 'FS_ERROR',
				message: e?.message ?? String(e),
			}
		})

		this.entryCache.set(key, p)
		return p
	}

	/* ── 枚举工作区目录（支持 workspaces/PNPM + 惯例） ── */
	private async enumerateWorkspaceDirs(root: string): Promise<string[]> {
		const pats = new Set<string>()
		const rootPkg = await this.safeReadPkg(root)
		const ws = (rootPkg as any)?.workspaces
		if (Array.isArray(ws)) ws.forEach((p) => pats.add(p))
		else if (ws?.packages && Array.isArray(ws.packages))
			ws.packages.forEach((p: string) => pats.add(p))

		const pnpmYaml = r(root, 'pnpm-workspace.yaml')
		if (existsSync(pnpmYaml))
			this.parsePnpm(readFileSync(pnpmYaml, 'utf8')).forEach((p) => pats.add(p))

		if (pats.size === 0) {
			pats.add('packages/*')
			pats.add('apps/*')
		}

		const out: string[] = []
		for (const pat of pats) {
			const m = pat.replace(/\/\*\*?$/, '/*').match(/^(.*)\/\*$/)
			if (!m) continue
			const base = r(root, m[1])
			try {
				const list = await readdir(base, { withFileTypes: true })
				for (const d of list) {
					if (!d.isDirectory()) continue
					const dir = r(base, d.name)
					if (existsSync(r(dir, 'package.json'))) out.push(normalize(dir))
				}
			} catch {}
		}
		return Array.from(new Set(out))
	}

	private parsePnpm(y: string): string[] {
		const lines = y.split(/\r?\n/)
		const res: string[] = []
		let inPk = false,
			indent = 0
		for (const raw of lines) {
			const line = raw.replace(/\t/g, '  ')
			if (!inPk) {
				const m = line.match(/^(\s*)packages\s*:\s*$/)
				if (m) {
					inPk = true
					indent = m[1].length
				}
				continue
			}
			if (line.trim() && line.match(new RegExp(`^\\s{0,${indent}}\\S`))) break
			const m2 = line.match(/^\s*-\s*['"]?([^'"]+)['"]?\s*$/)
			if (m2) res.push(m2[1])
		}
		return res
	}

	private async safeReadPkg(dir: string): Promise<any | undefined> {
		try {
			return await readPackageJSON(dir)
		} catch {
			return undefined
		}
	}

	private relName(root: string, dir: string): string {
		return (
			normalize(dir)
				.slice(normalize(root).length + 1)
				.replace(/\\/g, '/') || 'root'
		)
	}
}

/* ──────────────── 类型守卫（可选，方便外部更强收缩） ──────────────── */
export const isEntryOk = (r: EntryResult): r is EntryOk => r.ok
export const isRepoOk = (r: RepoResult): r is RepoOk => r.ok
