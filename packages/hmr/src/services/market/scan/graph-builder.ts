import os from 'node:os'
import { isAbsolute, normalize, resolve as r } from 'pathe'
import type { EntryResolver } from './entry-resolver'
import { getAllTsFiles } from './fs'
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

	const ctx: BuildContext = {
		entryResolver,
		options,
		entriesSet,
		fallbackSet,
		focusSet,
		matchedFocus,
		diagnostics,
	}

	let monoRoots = 0
	let packageCount = 0

	for (const dir of inputs) {
		const workspace = await loadWorkspaceInfo(dir)
		if (workspace.isMonorepo) {
			monoRoots++
			const packageDirs = new Set(workspace.packageDirs)
			const normalizedInput = normalize(dir)
			const normalizedWorkspaceRoot = normalize(workspace.root)
			let covered = false
			for (const pkgDir of packageDirs) {
				const normalizedPkg = normalize(pkgDir)
				if (
					normalizedInput === normalizedPkg ||
					normalizedInput.startsWith(`${normalizedPkg}/`) ||
					normalizedInput.startsWith(`${normalizedPkg}\\`)
				) {
					covered = true
					break
				}
			}
			if (!covered && (options.includeRoot || normalizedInput !== normalizedWorkspaceRoot)) {
				packageDirs.add(normalizedInput)
			}
			if (options.includeRoot) {
				packageDirs.add(workspace.root)
			}

			const rootPackages: PackageNode[] = []
			await Promise.all(
				Array.from(packageDirs).map((pkgDir) =>
					limit(async () => {
						const node = await processPackageDir({
							pkgDir,
							workspaceRoot: workspace.root,
							workspaceManifest: workspace.manifest,
							isExplicitInput: normalizedInput === normalize(pkgDir),
							ctx,
						})
						if (node) {
							rootPackages.push(node)
							packages.push(node)
							packageCount++
						}
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
			const node = await processPackageDir({
				pkgDir: dir,
				workspaceRoot: dir,
				workspaceManifest: workspace.manifest,
				isExplicitInput: true,
				ctx,
			})
			if (node) {
				packages.push(node)
				packageCount++
			}

			roots.push({
				kind: 'single',
				dir: normalize(dir),
				package: node ?? {
					dir: normalize(dir),
					entry: {
						ok: false,
						dir,
						code: 'NO_ENTRY',
						message: 'Entry not resolved.',
						tried: [],
					},
				},
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

async function processPackageDir(params: {
	pkgDir: string
	workspaceRoot: string
	workspaceManifest?: any
	isExplicitInput: boolean
	ctx: BuildContext
}): Promise<PackageNode | null> {
	const { pkgDir, workspaceRoot, workspaceManifest, isExplicitInput, ctx } = params
	const manifest =
		pkgDir === workspaceRoot ? workspaceManifest ?? (await safeReadManifest(pkgDir)) : await safeReadManifest(pkgDir)
	const manifestPath = manifestPathFor(pkgDir)
	const name = manifest?.name
	const normalizedDir = normalize(pkgDir)
	const focusSet = ctx.focusSet

	if (
		name &&
		focusSet &&
		focusSet.size &&
		!focusSet.has(name.toLowerCase()) &&
		!focusSet.has(normalizedDir.toLowerCase())
	) {
		return null
	}
	if (
		!name &&
		ctx.options.skipUnnamed &&
		!isExplicitInput &&
		(!focusSet || !focusSet.has(normalizedDir.toLowerCase()))
	) {
		return null
	}

	let entry: EntryResolution | null = null
	let fallbackFiles: string[] | undefined

	// 如果没有 manifest，直接走 TS fallback
	if (!manifest) {
		if (ctx.options.fallbackTsOnSingle) {
			const fallback = await resolveTsFallback(pkgDir, ctx)
			entry = fallback.entry
			fallbackFiles = fallback.fallbackFiles
		} else {
			entry = noManifestEntry(normalizedDir)
		}
	} else {
		entry = await ctx.entryResolver.resolve(pkgDir, ctx.options, manifest)
	}

	const node: PackageNode = {
		dir: normalizedDir,
		name: name ?? `@unknown/${relativeName(workspaceRoot, pkgDir)}`,
		entry,
	}
	if (manifestPath) node.manifestPath = manifestPath
	if (manifest) node.manifest = manifest
	if (fallbackFiles?.length) node.fallbackFiles = fallbackFiles

	if (focusSet) markFocusMatches(focusSet, ctx.matchedFocus, node)

	if (entry?.ok) {
		ctx.entriesSet.add(entry.entry)
		return node
	}

	ctx.diagnostics.push({
		severity: 'error',
		code: 'UNREADABLE_DIR',
		detail: entry?.message ?? 'Entry not resolved.',
		context: { dir: normalizedDir },
	})
	return node
}

async function resolveTsFallback(
	pkgDir: string,
	ctx: BuildContext,
): Promise<{ entry: EntryResolution; fallbackFiles: string[] }> {
	const normalizedDir = normalize(pkgDir)
	const files = await getAllTsFiles([pkgDir], {
		includeDts: false,
		followSymlinks: true,
		concurrency: Math.min((os.cpus()?.length ?? 4) * 2, 64),
	})
	if (files.length === 0) {
		return {
			entry: {
				ok: false,
				dir: normalizedDir,
				code: 'NO_TS_FILES',
				message: 'No .ts files found in directory.',
				tried: [],
			},
			fallbackFiles: [],
		}
	}

	const normalizedFiles = files.map(normalize)
	for (const file of normalizedFiles) ctx.fallbackSet.add(file)

	return {
		entry: {
			ok: true,
			dir: normalizedDir,
			entry: normalizedFiles[0],
			source: 'fallback',
			tried: [],
		},
		fallbackFiles: normalizedFiles,
	}
}

function noManifestEntry(dir: string): EntryResolution {
	return {
		ok: false,
		dir,
		code: 'NO_PACKAGE_JSON',
		message: 'package.json not found and TS fallback is disabled.',
		tried: [],
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
