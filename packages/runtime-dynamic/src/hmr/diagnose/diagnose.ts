import { resolve } from 'pathe'
import picomatch from 'picomatch'
import type { LoaderHmrWorkspaceSnapshot } from '../snapshot'
import {
	type PluxelLoaderHmrConfigV2,
	readLoaderHmrConfigV2,
	resolveDefaultLoaderHmrConfigPath,
} from './config'
import {
	type DiscoveredPlugin,
	discoverPluginsFromPackages,
	scanWorkspacePackages,
} from './discover'
import { toPosix, toRootRelative, uniqPreserveOrder, uniqSorted } from './utils'
import {
	DEFAULT_IGNORED_DIR_NAMES,
	crawlFilesAbsWithFs,
	loadWorkspaceInfoWithFs,
	nodeLoaderHmrWorkspaceFs,
	nodeWorkspaceFs,
	type LoaderHmrWorkspaceFs,
	type WorkspaceFs,
} from './fs'

export type DiagnoseWorkspaceInput = {
	rootDir: string
	configPath: string
	env?: Record<string, string | undefined>
	/**
	 * Package names to omit from discovery/enabled resolution.
	 */
	omitPackages?: string[]
	fs?: LoaderHmrWorkspaceFs
}

export type WorkspaceSnapshot = LoaderHmrWorkspaceSnapshot & { discovered: DiscoveredPlugin[] }

export type DiagnoseWorkspaceResult =
	| { ok: true; snapshot: WorkspaceSnapshot; warnings: string[] }
	| { ok: false; errors: string[]; discovered?: DiscoveredPlugin[] }

type MergedProfile = {
	activeProfile: string
	roots: 'auto' | string[]
	enabled: string[]
	includeGlobs: string[]
	excludeGlobs: string[]
}

export function mergeLoaderHmrProfile(
	cfg: PluxelLoaderHmrConfigV2,
	env?: Record<string, string | undefined>,
): MergedProfile {
	const activeProfile = env?.PLUXEL_HMR_PROFILE ?? cfg.profile
	const profile = cfg.profiles[activeProfile]
	if (!profile) {
		throw new Error(
			`[loader-hmr] Unknown profile "${activeProfile}". Available: ${Object.keys(cfg.profiles).join(', ')}`,
		)
	}

	const roots = profile.roots ?? cfg.defaults?.roots ?? 'auto'
	const enabled = profile.enabled
	const includeGlobs = [...(cfg.defaults?.include ?? []), ...(profile.include ?? [])]
	const excludeGlobs = [...(cfg.defaults?.exclude ?? []), ...(profile.exclude ?? [])]

	return { activeProfile, roots, enabled, includeGlobs, excludeGlobs }
}

export async function resolveLoaderHmrRootsExpanded(
	rootDir: string,
	roots: 'auto' | string[],
	fs: WorkspaceFs = nodeWorkspaceFs,
): Promise<string[]> {
	const base = resolve(rootDir)
	if (roots !== 'auto') return uniqSorted(roots.map((r) => toPosix(resolve(base, r))))

	const info = await loadWorkspaceInfoWithFs(base, fs)
	const rootsAbs = uniqSorted(info.packageDirs.length > 0 ? info.packageDirs : [info.root])
	return rootsAbs.map(toPosix)
}

function resolveGlobBaseDir(rootDirAbs: string, pattern: string) {
	const raw = pattern.trim().replace(/^!+/, '')
	// Avoid regex footguns for glob meta detection (`[`/`]`/`\` in char classes).
	// We only need a cheap "first meta" index to narrow crawl roots.
	let firstMeta = -1
	for (let i = 0; i < raw.length; i++) {
		const ch = raw.charCodeAt(i)
		// *, ?, [, ], {, }, (, )
		if (
			ch === 42 ||
			ch === 63 ||
			ch === 91 ||
			ch === 93 ||
			ch === 123 ||
			ch === 125 ||
			ch === 40 ||
			ch === 41
		) {
			firstMeta = i
			break
		}
	}
	const prefix = firstMeta >= 0 ? raw.slice(0, firstMeta) : raw
	const trimmed = prefix.replace(/\/+$/, '')
	if (!trimmed) return rootDirAbs
	const slash = trimmed.lastIndexOf('/')
	const dir = slash !== -1 ? trimmed.slice(0, slash) : '.'
	return resolve(rootDirAbs, dir)
}

async function resolveIncludeEntryFilesAbs(params: {
	rootDir: string
	includeGlobs: string[]
	excludeGlobs: string[]
	fs?: WorkspaceFs
}): Promise<string[]> {
	const rootDirAbs = resolve(params.rootDir)
	const fs = params.fs ?? nodeWorkspaceFs

	const includeAbs = params.includeGlobs.map((g) => toPosix(resolve(rootDirAbs, g)))
	if (includeAbs.length === 0) return []

	const excludeAbs = params.excludeGlobs.map((g) => toPosix(resolve(rootDirAbs, g)))
	const isIncluded = picomatch(includeAbs, { dot: true })
	const isExcluded = excludeAbs.length > 0 ? picomatch(excludeAbs, { dot: true }) : null

	const crawlRoots = uniqSorted(
		params.includeGlobs.map((p) => toPosix(resolveGlobBaseDir(rootDirAbs, p))),
	).filter((d) => fs.existsSync(d))

	const out = new Set<string>()
	for (const root of crawlRoots) {
		const files = await crawlFilesAbsWithFs(
			{
				roots: [root],
				ignoreDirNames: DEFAULT_IGNORED_DIR_NAMES,
				fileFilter: (p) =>
					p.endsWith('.ts') || p.endsWith('.tsx') || p.endsWith('.mts') || p.endsWith('.cts'),
			},
			fs,
		)

		for (const abs of files) {
			if (!isIncluded(abs)) continue
			if (isExcluded?.(abs)) continue
			out.add(abs)
		}
	}

	return [...out].sort((a, b) => a.localeCompare(b))
}

function findContainingWorkspacePackageName(
	fileAbs: string,
	packages: readonly { name: string; pkgDirAbs: string }[],
): string | null {
	const file = toPosix(fileAbs)
	let best: { name: string; dir: string } | null = null
	for (const p of packages) {
		const dir = toPosix(p.pkgDirAbs)
		const prefix = dir.endsWith('/') ? dir : `${dir}/`
		if ((file === dir || file.startsWith(prefix)) && (!best || dir.length > best.dir.length)) {
			best = { name: p.name, dir }
		}
	}
	return best?.name ?? null
}

function collectWorkspaceDependencyClosure(
	entryPackages: readonly string[],
	packages: readonly { name: string; deps: string[] }[],
	omit: ReadonlySet<string>,
): Set<string> {
	const depsByName = new Map(packages.map((p) => [p.name, p.deps]))
	const out = new Set<string>()
	const stack = [...entryPackages]

	while (stack.length > 0) {
		const name = stack.pop()
		if (!name || out.has(name) || omit.has(name) || !depsByName.has(name)) continue
		out.add(name)
		for (const dep of depsByName.get(name) ?? []) {
			if (!out.has(dep) && !omit.has(dep) && depsByName.has(dep)) stack.push(dep)
		}
	}

	return out
}

export async function buildWorkspaceSnapshotFromScan(params: {
	rootDir: string
	merged: MergedProfile
	rootsExpandedAbs: string[]
	packages: Array<{ name: string; deps: string[]; pkgDirAbs: string }>
	discovered: DiscoveredPlugin[]
	omitPackages?: string[]
	fs?: WorkspaceFs
}): Promise<DiagnoseWorkspaceResult> {
	const rootDirAbs = resolve(params.rootDir)
	const fs = params.fs ?? nodeWorkspaceFs

	const depsByName = new Map(params.packages.map((p) => [p.name, p.deps]))
	const discoveredSet = new Set(params.discovered.map((p) => p.name))

	const byPluginName = new Map<string, DiscoveredPlugin>()
	for (const p of params.discovered) byPluginName.set(p.name, p)

	const errors: string[] = []
	const enabledPackageEntriesAbs: string[] = []

	const omit = new Set((params.omitPackages ?? []).map((s) => String(s).trim()).filter(Boolean))
	const effectiveEnabled: string[] = []
	for (const name of params.merged.enabled) {
		if (omit.has(name)) continue
		effectiveEnabled.push(name)
	}

	for (const name of effectiveEnabled) {
		const plugin = byPluginName.get(name)
		if (!plugin) {
			errors.push(`[loader-hmr] Enabled plugin not found: ${name}`)
			continue
		}
		const entryAbs = toPosix(resolve(rootDirAbs, plugin.entry))
		if (!fs.existsSync(entryAbs)) {
			errors.push(`[loader-hmr] Plugin entry missing on disk: ${name} -> ${plugin.entry}`)
			continue
		}
		enabledPackageEntriesAbs.push(entryAbs)
	}

	const includeEntryFilesAbs = await resolveIncludeEntryFilesAbs({
		rootDir: rootDirAbs,
		includeGlobs: params.merged.includeGlobs,
		excludeGlobs: params.merged.excludeGlobs,
		fs: params.fs,
	})
	const includedEntries = includeEntryFilesAbs.map((abs) => toRootRelative(rootDirAbs, abs))

	if (errors.length > 0) return { ok: false, errors, discovered: params.discovered }

	const warnings: string[] = []

	{
		// Monorepo correctness: if a profile-selected Plugin package declares another Plugin package as a
		// dependency but that package is not selected, Runtime cannot resolve the provider when a node is
		// requested to run.
		const enabledSet = new Set(effectiveEnabled)
		const missingEdges: Array<{ from: string; missing: string[] }> = []
		for (const name of effectiveEnabled) {
			const deps = depsByName.get(name) ?? []
			const missing = deps
				.filter((d) => discoveredSet.has(d))
				.filter((d) => !enabledSet.has(d))
				.filter((d) => !omit.has(d))
			if (missing.length > 0) missingEdges.push({ from: name, missing: uniqSorted(missing) })
		}
		if (missingEdges.length > 0) {
			const maxEdges = 20
			const shown = missingEdges.slice(0, maxEdges)
			warnings.push(
				`[loader-hmr] ${missingEdges.length} selected Plugin package(s) depend on other Plugin packages that are not selected in this profile. Consider adding them to profile.enabled so required providers are available when their consumers are requested to run.`,
			)
			for (const edge of shown) {
				warnings.push(
					`[loader-hmr] Missing profile packages: ${edge.from} -> ${edge.missing.join(', ')}`,
				)
			}
			if (missingEdges.length > maxEdges) {
				warnings.push(
					`[loader-hmr] …and ${missingEdges.length - maxEdges} more missing-deps edge(s).`,
				)
			}
		}
	}
	const roots = params.rootsExpandedAbs.map((r) => toRootRelative(rootDirAbs, r))
	const includeGlobs = uniqPreserveOrder(params.merged.includeGlobs)
	const excludeGlobs = uniqPreserveOrder(params.merged.excludeGlobs)

	const enabledEntries = uniqPreserveOrder([
		...enabledPackageEntriesAbs.map((abs) => toRootRelative(rootDirAbs, abs)),
		...includedEntries,
	])

	// Watch roots: selected Plugin package dirs + include-containing package + non-package include dirs.
	const watchRootsAbs = new Set<string>()
	const packageByName = new Map(params.packages.map((p) => [p.name, p]))
	for (const name of collectWorkspaceDependencyClosure(effectiveEnabled, params.packages, omit)) {
		const pkg = packageByName.get(name)
		if (pkg) watchRootsAbs.add(toPosix(pkg.pkgDirAbs))
	}
	for (const abs of includeEntryFilesAbs) {
		const pkgName = findContainingWorkspacePackageName(abs, params.packages)
		if (pkgName) {
			const pkg = params.packages.find((p) => p.name === pkgName)
			if (pkg) watchRootsAbs.add(toPosix(pkg.pkgDirAbs))
		} else {
			watchRootsAbs.add(toPosix(resolve(rootDirAbs, abs, '..')))
		}
	}
	const watchRoots = uniqSorted([...watchRootsAbs]).map((abs) => toRootRelative(rootDirAbs, abs))

	const snapshot: WorkspaceSnapshot = {
		activeProfile: params.merged.activeProfile,
		roots,
		enabled: effectiveEnabled,
		enabledEntries,
		includedEntries,
		discovered: params.discovered,
		watchRoots,
		includeGlobs,
		excludeGlobs,
	}

	return { ok: true, snapshot, warnings }
}

export async function diagnoseWorkspace(
	input: DiagnoseWorkspaceInput,
): Promise<DiagnoseWorkspaceResult> {
	const rootDirAbs = resolve(input.rootDir)
	const configPathAbs = resolve(rootDirAbs, input.configPath)
	const fs = input.fs ?? nodeLoaderHmrWorkspaceFs

	if (!fs.existsSync(configPathAbs))
		return { ok: false, errors: [`Missing config file: ${configPathAbs}`] }

	let cfg: PluxelLoaderHmrConfigV2
	try {
		cfg = readLoaderHmrConfigV2(configPathAbs, fs)
	} catch (error) {
		return { ok: false, errors: [error instanceof Error ? error.message : String(error)] }
	}

	let merged: MergedProfile
	try {
		merged = mergeLoaderHmrProfile(cfg, input.env)
	} catch (error) {
		return { ok: false, errors: [error instanceof Error ? error.message : String(error)] }
	}

	let rootsExpandedAbs: string[]
	try {
		rootsExpandedAbs = await resolveLoaderHmrRootsExpanded(rootDirAbs, merged.roots, fs)
	} catch (error) {
		return { ok: false, errors: [error instanceof Error ? error.message : String(error)] }
	}

	const { packages } = await scanWorkspacePackages({
		rootDir: rootDirAbs,
		roots: rootsExpandedAbs,
		excludeGlobs: merged.excludeGlobs,
		fs,
	})
	const discovered = discoverPluginsFromPackages(rootDirAbs, packages)

	const omitPackages = uniqSorted(input.omitPackages ?? [])

	const base = await buildWorkspaceSnapshotFromScan({
		rootDir: rootDirAbs,
		merged,
		rootsExpandedAbs,
		packages: packages.map((p) => ({ name: p.name, deps: p.deps, pkgDirAbs: p.pkgDirAbs })),
		discovered,
		omitPackages: omitPackages.length > 0 ? omitPackages : undefined,
		fs,
	})

	return base
}

export function resolveLoaderHmrConfigPathFromCwd(cwd = process.cwd()) {
	return resolveDefaultLoaderHmrConfigPath(cwd)
}
