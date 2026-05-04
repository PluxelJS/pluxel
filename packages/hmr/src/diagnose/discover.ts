import { dirname, resolve } from 'pathe'
import type { PackageJson } from 'pkg-types'
import picomatch from 'picomatch'
import { PLUXEL_CONDITION_HMR } from '@pluxel/runtime/shared'
import { toPosix, toRootRelative, uniqSorted } from './utils'
import {
	DEFAULT_IGNORED_DIR_NAMES,
	crawlFilesAbsWithFs,
	nodeWorkspaceFs,
	readTextFile,
	type WorkspaceFs,
} from './fs'

export type DiscoverWorkspacePluginsInput = {
	rootDir: string
	roots: string[]
	excludeGlobs: string[]
}

export type DiscoveredPlugin = {
	name: string
	pkgDir: string // root-relative
	entry: string // root-relative
}

export type WorkspacePackage = {
	name: string
	pkgDirAbs: string
	pkgDir: string // root-relative
	manifest: PackageJson
	deps: string[]
}

function normalizeMatchers(rootDir: string, excludeGlobs: string[]) {
	const patterns = excludeGlobs.length > 0
		? excludeGlobs.map((g) => toPosix(resolve(rootDir, g)))
		: [resolve(rootDir, '**/node_modules/**'), resolve(rootDir, '**/dist/**')]
	return picomatch(patterns.map(toPosix), { dot: true })
}

async function safeReadPackageJson(
	path: string,
	fs: WorkspaceFs = nodeWorkspaceFs,
): Promise<PackageJson | null> {
	try {
		const raw = await readTextFile(fs, path)
		return JSON.parse(raw) as PackageJson
	} catch {
		return null
	}
}

function collectWorkspaceDepNames(manifest: PackageJson): string[] {
	const sets: Array<Record<string, unknown> | undefined> = [
		(manifest as any).dependencies,
		(manifest as any).devDependencies,
		(manifest as any).peerDependencies,
		(manifest as any).optionalDependencies,
	]
	const out = new Set<string>()
	for (const rec of sets) {
		if (!rec || typeof rec !== 'object') continue
		for (const k of Object.keys(rec)) out.add(k)
	}
	return [...out]
}

function resolvePluginEntryAbs(pkgDirAbs: string, manifest: PackageJson): string | null {
	const name = manifest.name
	if (typeof name !== 'string' || !name.trim()) return null

	const exportsField = (manifest as any).exports
	if (!exportsField || typeof exportsField !== 'object') return null
	const dot = (exportsField as any)['.']
	if (!dot || typeof dot !== 'object') return null
	const hmr = (dot as any)[PLUXEL_CONDITION_HMR]
	if (typeof hmr !== 'string' || !hmr.trim()) return null

	return resolve(pkgDirAbs, hmr)
}

export async function scanWorkspacePackages(
	input: DiscoverWorkspacePluginsInput & { fs?: WorkspaceFs },
): Promise<{ packages: WorkspacePackage[]; packageJsonPathsAbs: string[] }> {
	const rootDirAbs = resolve(input.rootDir)
	const isExcluded = normalizeMatchers(rootDirAbs, input.excludeGlobs)
	const fs = input.fs ?? nodeWorkspaceFs

	const rootsAbs = uniqSorted(
		input.roots
			.map((r) => resolve(rootDirAbs, r))
			.filter((p) => fs.existsSync(p))
			.map(toPosix),
	)

	const packageJsonPathsAbs: string[] = []

	for (const root of rootsAbs) {
		const direct = resolve(root, 'package.json')
		if (fs.existsSync(direct) && !isExcluded(toPosix(direct))) {
			packageJsonPathsAbs.push(toPosix(direct))
			continue
		}

		const files = await crawlFilesAbsWithFs(
			{
				roots: [root],
				ignoreDirNames: DEFAULT_IGNORED_DIR_NAMES,
				fileFilter: (p) => p.endsWith('package.json'),
			},
			fs,
		)

		for (const abs of files) {
			if (isExcluded(abs)) continue
			packageJsonPathsAbs.push(abs)
		}
	}

	const uniquePaths = uniqSorted(packageJsonPathsAbs)

	const packages: WorkspacePackage[] = []
	for (const pkgJsonPathAbs of uniquePaths) {
		const manifest = await safeReadPackageJson(pkgJsonPathAbs, fs)
		if (!manifest) continue
		const name = manifest.name
		if (typeof name !== 'string' || !name.trim()) continue
		const pkgDirAbs = toPosix(dirname(pkgJsonPathAbs))
		packages.push({
			name,
			pkgDirAbs,
			pkgDir: toRootRelative(rootDirAbs, pkgDirAbs),
			manifest,
			deps: collectWorkspaceDepNames(manifest),
		})
	}

	return { packages, packageJsonPathsAbs: uniquePaths }
}

export function discoverPluginsFromPackages(
	rootDir: string,
	packages: readonly WorkspacePackage[],
): DiscoveredPlugin[] {
	const rootDirAbs = resolve(rootDir)
	const out: DiscoveredPlugin[] = []
	for (const pkg of packages) {
		const entryAbs = resolvePluginEntryAbs(pkg.pkgDirAbs, pkg.manifest)
		if (!entryAbs) continue
		out.push({
			name: pkg.name,
			pkgDir: pkg.pkgDir,
			entry: toRootRelative(rootDirAbs, entryAbs),
		})
	}
	out.sort((a, b) => a.name.localeCompare(b.name))
	return out
}

export async function discoverWorkspacePlugins(
	input: DiscoverWorkspacePluginsInput & { fs?: WorkspaceFs },
): Promise<DiscoveredPlugin[]> {
	const { packages } = await scanWorkspacePackages(input)
	return discoverPluginsFromPackages(input.rootDir, packages)
}
