import fs from 'node:fs/promises'
import os from 'node:os'
import { crawlFilesAbs, DEFAULT_IGNORED_DIR_NAMES } from '@pluxel/workspace'
import { extname, isAbsolute, normalize, resolve } from 'pathe'
import { createLimiter } from './limit'

export interface TsScanOptions {
	exts?: string[]
	includeDts?: boolean
	followSymlinks?: boolean
	ignoreDirs?: string[]
	concurrency?: number
}

export async function getAllTsFiles(inputs: string[], opts: TsScanOptions = {}): Promise<string[]> {
	const extensions = normalizeExtensions(opts.exts)
	const includeDts = opts.includeDts ?? false
	const followSymlinks = opts.followSymlinks ?? true
	const concurrency = Math.max(1, Math.min(opts.concurrency ?? (os.cpus()?.length ?? 4) * 2, 64))
	const ignoreDirNames = new Set([...(opts.ignoreDirs ?? []), ...DEFAULT_IGNORED_DIR_NAMES])

	const out = new Set<string>()
	const dirsToScan: string[] = []
	const limit = createLimiter(concurrency)

	for (const input of inputs) {
		const abs = toAbsolute(input)
		const st = await fs.stat(abs).catch((): null => null)
		if (!st) continue

		if (st.isDirectory()) {
			const base = abs.split(/[\\/]/).pop()
			if (base && ignoreDirNames.has(base)) continue
			dirsToScan.push(abs)
		} else if (st.isFile()) {
			if (shouldInclude(abs, extensions, includeDts)) {
				out.add(normalize(abs))
			}
		}
	}

	await Promise.all(
		dirsToScan.map((dir) =>
			limit(async () => {
				const matches = await crawlFilesAbs({
					roots: [dir],
					followSymlinks,
					ignoreDirNames,
					fileFilter: (p) => shouldInclude(p, extensions, includeDts),
				})

				for (const file of matches) out.add(normalize(file))
			}),
		),
	)

	return [...out].sort((a, b) => a.localeCompare(b))
}

function toAbsolute(input: string): string {
	return isAbsolute(input) ? input : resolve(process.cwd(), input)
}

function normalizeExtensions(exts?: string[]): Set<string> {
	const list = exts?.length ? exts : ['.ts', '.tsx', '.mts', '.cts']
	return new Set(
		list.map((ext) => (ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`)),
	)
}

function shouldInclude(filePath: string, exts: Set<string>, includeDts: boolean): boolean {
	const ext = extname(filePath).toLowerCase()
	if (!exts.has(ext)) return false
	if (!includeDts) {
		const lower = filePath.toLowerCase()
		if (lower.endsWith('.d.ts') || lower.endsWith('.d.mts') || lower.endsWith('.d.cts'))
			return false
	}
	return true
}
