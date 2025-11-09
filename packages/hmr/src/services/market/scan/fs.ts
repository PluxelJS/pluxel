import fs from 'node:fs/promises'
import os from 'node:os'
import { extname, isAbsolute, normalize, resolve } from 'pathe'
import { glob } from 'tinyglobby'
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
	const extensions = normalizeExtensions(opts.exts)
	const includeDts = opts.includeDts ?? false
	const followSymlinks = opts.followSymlinks ?? true
	const concurrency = Math.max(1, Math.min(opts.concurrency ?? (os.cpus()?.length ?? 4) * 2, 64))
	const ignoreDirNames = new Set([...(opts.ignoreDirs ?? []), ...DEFAULT_IGNORES])
	const ignoreGlobs = createIgnoreGlobs(ignoreDirNames, includeDts)

	const out = new Set<string>()
	const dirsToScan: string[] = []
	const limit = createLimiter(concurrency)

	for (const input of inputs) {
		const abs = toAbsolute(input)
		const st = await fs.stat(abs).catch(() => null)
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
				const matches = await glob(createPatterns(extensions), {
					cwd: dir,
					absolute: true,
					onlyFiles: true,
					followSymbolicLinks: followSymlinks,
					ignore: ignoreGlobs,
					caseSensitiveMatch: false,
				})
				for (const file of matches) {
					if (shouldInclude(file, extensions, includeDts)) {
						out.add(normalize(file))
					}
				}
			}),
		),
	)

	return [...out]
}

function toAbsolute(input: string): string {
	return isAbsolute(input) ? input : resolve(process.cwd(), input)
}

function normalizeExtensions(exts?: string[]): Set<string> {
	const list = exts && exts.length ? exts : ['.ts']
	return new Set(
		list.map((ext) => (ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`)),
	)
}

function createPatterns(exts: Set<string>): string[] {
	return Array.from(exts).map((ext) => `**/*${ext}`)
}

function createIgnoreGlobs(ignoreDirs: Set<string>, includeDts: boolean): string[] {
	const ignores = Array.from(ignoreDirs).map((dir) => `**/${dir}/**`)
	if (!includeDts) ignores.push('**/*.d.ts')
	return ignores
}

function shouldInclude(filePath: string, exts: Set<string>, includeDts: boolean): boolean {
	const ext = extname(filePath).toLowerCase()
	if (!exts.has(ext)) return false
	if (!includeDts && filePath.toLowerCase().endsWith('.d.ts')) return false
	return true
}
