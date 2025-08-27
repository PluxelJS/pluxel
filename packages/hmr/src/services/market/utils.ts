import fs from 'node:fs/promises'
import os from 'node:os'
import { extname, isAbsolute, join } from 'node:path'
import { normalize, resolve } from 'pathe'
import { resolvePath } from 'mlly'

/* --------------------- package entry (with cache & fallback) --------------------- */

const entryCache = new Map<string, Promise<string>>()

/** 可选：暴露清缓存 */
export function clearEntryCache() {
	entryCache.clear()
}

/**
 * dev 时优先用条件导出 '@pluxel/source'，失败则回退到默认分辨；
 * 结果 Promise 缓存，避免重复 I/O。
 */
export function scanPackageEntryByPath(
	spec: string,
	isDev: boolean,
): Promise<string> {
	const key = `${spec}::${isDev}`
	let p = entryCache.get(key)
	if (!p) {
		p = resolvePath(spec, {
			conditions: isDev ? ['@pluxel/source'] : undefined,
		}).catch((err) => {
			// dev 条件导出失败 → 回退普通分辨
			if (isDev) return resolvePath(spec)
			throw err
		})
		entryCache.set(key, p)
	}
	return p
}

/* --------------------- TS file scanner (fast, robust, configurable) --------------------- */

type TsScanOptions = {
	exts?: string[] // 要包含的扩展名，默认 ['.ts']
	includeDts?: boolean // 是否包含 .d.ts，默认 false
	followSymlinks?: boolean // 是否跟随符号链接，默认 true
	ignoreDirs?: string[] // 要忽略的目录名（仅名字匹配），默认常见构建/缓存目录
	concurrency?: number // 并发上限，默认 2×CPU，最大不超过 64
}

const DEFAULT_IGNORES = [
	'node_modules',
	'.git',
	'dist',
	'build',
	'.next',
	'.turbo',
	'coverage',
	'.cache',
]

/** 超轻量并发限制器（无依赖） */
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

export async function getAllTsFiles(
	inputs: string[],
	opts: TsScanOptions = {},
): Promise<string[]> {
	const exts = new Set((opts.exts ?? ['.ts']).map((e) => e.toLowerCase()))
	const includeDts = opts.includeDts ?? false
	const followSymlinks = opts.followSymlinks ?? true
	const concurrency = Math.max(
		1,
		Math.min(opts.concurrency ?? (os.cpus()?.length ?? 4) * 2, 64),
	)
	const ignoreDirs = new Set([...(opts.ignoreDirs ?? []), ...DEFAULT_IGNORES])

	const want = (filePathOrName: string) => {
		const ext = extname(filePathOrName).toLowerCase()
		if (!exts.has(ext)) return false
		if (!includeDts && filePathOrName.toLowerCase().endsWith('.d.ts'))
			return false
		return true
	}

	const out = new Set<string>() // 去重
	const seenDirReal = new Set<string>() // 防 symlink 循环
	const limit = pLimit(concurrency)

	async function walkDir(dir: string): Promise<void> {
		// 只有在跟随 symlink 时才做 realpath 去重
		if (followSymlinks) {
			const real = await fs.realpath(dir).catch(() => dir)
			if (seenDirReal.has(real)) return
			seenDirReal.add(real)
		}

		const handle = await fs.opendir(dir)
		const subtasks: Promise<unknown>[] = []

		for await (const dirent of handle) {
			const name = dirent.name
			const full = join(dir, name)

			if (dirent.isDirectory()) {
				if (ignoreDirs.has(name)) continue
				subtasks.push(limit(() => walkDir(full)))
			} else if (dirent.isFile()) {
				if (want(name)) out.add(normalize(full))
			} else if (followSymlinks && dirent.isSymbolicLink()) {
				// 解析一次 symlink：可能指向目录或文件
				const st = await fs.stat(full).catch(() => null)
				if (!st) continue
				if (st.isDirectory()) {
					if (ignoreDirs.has(name)) continue
					subtasks.push(limit(() => walkDir(full)))
				} else if (st.isFile() && want(full)) {
					out.add(normalize(full))
				}
			}
		}

		if (subtasks.length) await Promise.all(subtasks)
	}

	// 支持目录/文件混投；文件匹配扩展名即加入
	for (const input of inputs) {
		const abs = isAbsolute(input) ? input : resolve(process.cwd(), input)
		const st = await fs.stat(abs).catch(() => null)
		if (!st) continue
		if (st.isDirectory()) {
			const base = abs.split(/[\\/]/).pop()!
			if (!ignoreDirs.has(base)) await walkDir(abs)
		} else if (st.isFile()) {
			if (want(abs)) out.add(normalize(abs))
		}
	}

	return [...out]
}
