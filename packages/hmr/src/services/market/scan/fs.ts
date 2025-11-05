import fs from 'node:fs/promises'
import os from 'node:os'
import { extname, isAbsolute, join, normalize, resolve } from 'pathe'
import { createLimiter } from './limit'

export interface TsScanOptions {
	exts?: string[]
	includeDts?: boolean
	followSymlinks?: boolean
	ignoreDirs?: string[]
	concurrency?: number
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

export async function getAllTsFiles(inputs: string[], opts: TsScanOptions = {}): Promise<string[]> {
	const exts = new Set((opts.exts ?? ['.ts']).map((e) => e.toLowerCase()))
	const includeDts = opts.includeDts ?? false
	const followSymlinks = opts.followSymlinks ?? true
	const concurrency = Math.max(1, Math.min(opts.concurrency ?? (os.cpus()?.length ?? 4) * 2, 64))
	const ignoreDirs = new Set([...(opts.ignoreDirs ?? []), ...DEFAULT_IGNORES])

	const want = (filePathOrName: string) => {
		const ext = extname(filePathOrName).toLowerCase()
		if (!exts.has(ext)) return false
		if (!includeDts && filePathOrName.toLowerCase().endsWith('.d.ts')) return false
		return true
	}

	const out = new Set<string>()
	const seenDirReal = new Set<string>()
	const limit = createLimiter(concurrency)

	async function walkDir(dir: string): Promise<void> {
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
