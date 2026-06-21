import { existsSync } from 'node:fs'
import { posix, resolve } from 'pathe'
import { fdir } from 'fdir'
import {
	nodeWorkspaceFs,
	type WorkspaceDirEntryLike,
	type WorkspaceFs,
	type WorkspaceStatsLike,
} from './fs'

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
	return posix.normalize(p)
}

function uniqSorted(items: readonly string[]): string[] {
	return [...new Set(items)].sort((a, b) => a.localeCompare(b))
}

export async function crawlFilesAbs(opts: CrawlFilesOptions): Promise<string[]> {
	return await crawlFilesAbsWithFs(opts, nodeWorkspaceFs)
}

async function visitFiles(params: {
	dir: string
	fs: WorkspaceFs
	ignore: Set<string>
	followSymlinks: boolean
	fileFilter?: (fullPath: string) => boolean
	out: string[]
	seen: Set<string>
}) {
	let entries: WorkspaceDirEntryLike[]
	try {
		entries = (await params.fs.promises.readdir(params.dir, {
			withFileTypes: true,
		})) as unknown as WorkspaceDirEntryLike[]
	} catch {
		return
	}

	for (const entry of entries) {
		const fullPath = toPosix(resolve(params.dir, entry.name))
		if (entry.isDirectory?.()) {
			if (params.ignore.has(entry.name)) continue
			if (params.seen.has(fullPath)) continue
			params.seen.add(fullPath)
			await visitFiles({ ...params, dir: fullPath })
			continue
		}
		if (entry.isSymbolicLink?.()) {
			if (!params.followSymlinks) continue
			let resolvedPath: string
			let resolvedStats: WorkspaceStatsLike
			try {
				resolvedPath = toPosix(await params.fs.promises.realpath(fullPath))
				resolvedStats = await params.fs.promises.stat(fullPath)
			} catch {
				continue
			}
			if (resolvedStats.isDirectory?.()) {
				const baseName = resolvedPath.split('/').pop() ?? ''
				if (params.ignore.has(baseName)) continue
				if (params.seen.has(resolvedPath)) continue
				params.seen.add(resolvedPath)
				await visitFiles({ ...params, dir: resolvedPath })
				continue
			}
			if (resolvedStats.isFile?.() && (!params.fileFilter || params.fileFilter(resolvedPath))) {
				params.out.push(resolvedPath)
			}
			continue
		}
		if (!params.fileFilter || params.fileFilter(fullPath)) params.out.push(fullPath)
	}
}

export async function crawlFilesAbsWithFs(
	opts: CrawlFilesOptions,
	fs: WorkspaceFs = nodeWorkspaceFs,
): Promise<string[]> {
	if (fs === nodeWorkspaceFs) {
		return await crawlFilesAbsNode(opts)
	}

	const followSymlinks = opts.followSymlinks ?? true
	const ignore = new Set<string>(opts.ignoreDirNames ?? DEFAULT_IGNORED_DIR_NAMES)
	const roots = uniqSorted(
		opts.roots.map((root) => toPosix(resolve(root))).filter((root) => fs.existsSync(root)),
	)
	const out: string[] = []
	const seen = new Set<string>()

	for (const root of roots) {
		if (seen.has(root)) continue
		seen.add(root)
		await visitFiles({
			dir: root,
			fs,
			ignore,
			followSymlinks,
			fileFilter: opts.fileFilter,
			out,
			seen,
		})
	}

	return uniqSorted(out)
}

async function crawlFilesAbsNode(opts: CrawlFilesOptions): Promise<string[]> {
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
