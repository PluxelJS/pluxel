import os from 'node:os'
import { isAbsolute, normalize, resolve as r } from 'pathe'
import { getAllTsFiles } from './fs'
import type { EntryResolver } from './entry-resolver'
import { createLimiter } from './limit'
import { manifestPathFor, safeReadManifest } from './package'
import type {
	EntryResolution,
	PackageNode,
	ResolvedScanOptions,
	ScanDiagnostic,
	ScanGraph,
	ScanRoot,
	ScanStats,
} from './types'
import { loadWorkspaceInfo } from './workspace'

export async function buildScanGraph(
	input: string[],
	options: ResolvedScanOptions,
	entryResolver: EntryResolver,
): Promise<ScanGraph> {
	const startedAt = Date.now()
	const inputs = normalizeInputs(input)
	const limit = createLimiter(Math.max(1, options.batchSize))
	const focusSet =
		options.focusPackages && options.focusPackages.length
			? new Set(options.focusPackages)
			: undefined
	const matchedFocus = new Set<string>()

	const roots: ScanRoot[] = []
	const packages: PackageNode[] = []
	const entriesSet = new Set<string>()
	const fallbackSet = new Set<string>()
	const diagnostics: ScanDiagnostic[] = []

	let monoRoots = 0
	let packageCount = 0

	for (const dir of inputs) {
		const workspace = await loadWorkspaceInfo(dir)
		if (workspace.isMonorepo) {
			monoRoots++
			const packageDirs = new Set(workspace.packageDirs)
			if (options.includeRoot) {
				packageDirs.add(workspace.root)
			}

			const rootPackages: PackageNode[] = []
			await Promise.all(
				Array.from(packageDirs).map((pkgDir) =>
					limit(async () => {
						const manifest =
							pkgDir === workspace.root ? workspace.manifest : await safeReadManifest(pkgDir)
						const manifestPath = manifestPathFor(pkgDir)
						const name = manifest?.name
						const normalizedDir = normalize(pkgDir)
						if (
							name &&
							focusSet &&
							focusSet.size &&
							!focusSet.has(name.toLowerCase()) &&
							!focusSet.has(normalizedDir.toLowerCase())
						) {
							return
						}
						if (
							!name &&
							options.skipUnnamed &&
							(!focusSet || !focusSet.has(normalizedDir.toLowerCase()))
						) {
							return
						}

						const entry = await entryResolver.resolve(pkgDir, options, manifest)
						const node: PackageNode = {
							dir: normalizedDir,
							name: name ?? `@unknown/${relativeName(workspace.root, pkgDir)}`,
							entry,
						}
						if (manifestPath) node.manifestPath = manifestPath
						if (manifest) node.manifest = manifest

						rootPackages.push(node)
						packages.push(node)
						if (focusSet) markFocusMatches(focusSet, matchedFocus, node)
						packageCount++
						if (entry.ok) entriesSet.add(entry.entry)
					}),
				),
			)

			roots.push({
				kind: 'monorepo',
				root: workspace.root,
				includedRoot: options.includeRoot,
				packages: rootPackages.sort(byPackageDir),
			})
		} else {
			const manifest = workspace.manifest ?? (await safeReadManifest(dir))
			const entry = await entryResolver.resolve(dir, options, manifest)
			const manifestPath = manifestPathFor(dir)
			const normalizedDir = normalize(dir)
			const node: PackageNode = {
				dir: normalizedDir,
				entry,
			}
			const manifestName = manifest?.name
			if (manifestName) node.name = manifestName
			if (manifestPath) node.manifestPath = manifestPath
			if (manifest) node.manifest = manifest

			if (focusSet) markFocusMatches(focusSet, matchedFocus, node)

			if (entry.ok) {
				entriesSet.add(entry.entry)
			} else if (options.fallbackTsOnSingle) {
				const files = await getAllTsFiles([dir], {
					includeDts: false,
					followSymlinks: true,
					concurrency: Math.min((os.cpus()?.length ?? 4) * 2, 64),
				})
				if (files.length === 0) {
					diagnostics.push({
						severity: 'error',
						code: 'NO_TS_FILES',
						detail: 'No .ts files found in directory after entry resolution failed.',
						context: { dir: normalizedDir },
					})
				} else {
					node.fallbackFiles = files.map(normalize)
					for (const file of node.fallbackFiles) fallbackSet.add(file)
				}
			} else if (!entry.ok) {
				diagnostics.push({
					severity: 'error',
					code: 'UNREADABLE_DIR',
					detail: entry.message,
					context: { dir: normalizedDir },
				})
			}

			packages.push(node)
			packageCount++

			roots.push({
				kind: 'single',
				dir: normalizedDir,
				package: node,
			})
		}
	}

	const stats: ScanStats = {
		monoRoots,
		packages: packageCount,
		entries: entriesSet.size,
		tsFiles: fallbackSet.size,
		durationMs: Date.now() - startedAt,
	}

	if (focusSet) {
		for (const focus of focusSet) {
			if (!matchedFocus.has(focus)) {
				diagnostics.push({
					severity: 'error',
					code: 'PACKAGE_NOT_FOUND',
					detail: `Package "${focus}" not found in provided inputs.`,
					context: { focus },
				})
			}
		}
	}

	return {
		inputs,
		options,
		roots,
		packages: packages.sort(byPackageDir),
		entries: Array.from(entriesSet).map(normalize),
		fallbackEntries: Array.from(fallbackSet).map(normalize),
		diagnostics,
		stats,
	}
}

function normalizeInputs(inputs: string[]): string[] {
	return inputs.map((input) => {
		const abs = isAbsolute(input) ? input : r(process.cwd(), input)
		return normalize(abs)
	})
}

function byPackageDir(a: PackageNode, b: PackageNode) {
	return a.dir.localeCompare(b.dir)
}

function relativeName(root: string, dir: string) {
	const rel = normalize(dir)
		.slice(normalize(root).length)
		.replace(/^[/\\]/, '')
		.replace(/\\/g, '/')
	return rel || 'root'
}

function markFocusMatches(focusSet: Set<string>, matched: Set<string>, node: PackageNode) {
	const dirKey = node.dir.toLowerCase()
	if (focusSet.has(dirKey)) matched.add(dirKey)
	if (node.name) {
		const nameKey = node.name.toLowerCase()
		if (focusSet.has(nameKey)) matched.add(nameKey)
	}
}
