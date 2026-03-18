import { existsSync } from 'node:fs'
import { resolve } from 'pathe'
import { fdir } from 'fdir'

export const DEFAULT_IGNORED_DIR_NAMES = [
	'node_modules',
	'.git',
	'.turbo',
	'.output',
	'.next',
	'.nuxt',
	'.cache',
	'dist',
] as const

export type CrawlFilesOptions = {
	roots: string[]
	ignoreDirNames?: Iterable<string>
	followSymlinks?: boolean
	/**
	 * Called with full path (platform path separators as produced by the crawler).
	 * Return true to keep the file.
	 */
	fileFilter?: (fullPath: string) => boolean
}

function toPosix(p: string) {
	return p.replace(/\\/g, '/')
}

function uniqSorted(items: readonly string[]): string[] {
	return [...new Set(items)].sort((a, b) => a.localeCompare(b))
}

export async function crawlFilesAbs(opts: CrawlFilesOptions): Promise<string[]> {
	const followSymlinks = opts.followSymlinks ?? true
	const ignore = new Set<string>(opts.ignoreDirNames ?? DEFAULT_IGNORED_DIR_NAMES)

	const out: string[] = []

	for (const root of opts.roots) {
		const absRoot = toPosix(resolve(root))
		if (!existsSync(absRoot)) continue

		let crawler = new fdir().withFullPaths().exclude((name) => ignore.has(name))
		if (followSymlinks) crawler = crawler.withSymlinks({ resolvePaths: true })

		const files = await crawler
			.filter((p, isDirectory) => {
				if (isDirectory) return true
				return opts.fileFilter ? opts.fileFilter(p) : true
			})
			.crawl(absRoot)
			.withPromise()

		for (const f of files) out.push(toPosix(f))
	}

	return uniqSorted(out)
}
