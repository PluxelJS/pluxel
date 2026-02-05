import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'pathe'
import picomatch from 'picomatch'
import { crawlFilesAbs, DEFAULT_IGNORED_DIR_NAMES, loadWorkspaceInfo } from '../workspace'
import { type PluxelHmrConfigV1, readHmrConfigV1, resolveDefaultHmrConfigPath } from './config'
import {
	type DiscoveredPlugin,
	discoverPluginsFromPackages,
	scanWorkspacePackages,
} from './discover'
import { toPosix, toRootRelative, uniqPreserveOrder, uniqSorted } from './utils'

export type DiagnoseWorkspaceInput = {
	rootDir: string
	configPath: string
	env?: Record<string, string | undefined>
	/**
	 * Package names to omit from discovery/enabled resolution.
	 *
	 * Primary use case: the host preloads certain packages as builtins (baseline),
	 * so workspace profiles should not also load their `@pluxel/hmr` source entries
	 * (prevents "plugin name conflict" from double-loading the same package).
	 */
	omitPackages?: string[]
}

export type WorkspaceSnapshot = {
	activeProfile: string
	roots: string[] // expanded roots, root-relative
	enabled: string[] // effective enabled package names
	/**
	 * Workspace plugin packages that are provided by the host as builtins (baseline).
	 *
	 * These packages are omitted from discovery/entries resolution to prevent double-loading.
	 */
	builtinPackages: string[]
	/**
	 * Startup entry list (stable order):
	 * - enabled plugin package entries (config order)
	 * - plus resolved include entry files (sorted)
	 */
	enabledEntries: string[]
	/** Resolved include entry files (after glob expansion), root-relative. */
	includedEntries: string[]
	discovered: DiscoveredPlugin[]
	/**
	 * Watch roots (root-relative):
	 * - enabled plugin packages
	 * - plus any packages containing include entries (and any non-package include dirs)
	 */
	watchRoots: string[]
	/** HMRService.include globs (root-relative unless absolute). */
	includeGlobs: string[]
	/** HMRService.exclude globs (root-relative unless absolute). */
	excludeGlobs: string[]
}

export type DiagnoseWorkspaceResult =
	| { ok: true; snapshot: WorkspaceSnapshot; warnings: string[] }
	| { ok: false; errors: string[]; discovered?: DiscoveredPlugin[] }

type MergedProfile = {
	activeProfile: string
	roots: 'auto' | string[]
	enabled: string[]
	builtinPackages: string[]
	includeGlobs: string[]
	excludeGlobs: string[]
}

const MANAGED_PLUGIN_PKG_RE = /^(?:@[^/]+\/)?pluxel-plugin-/i

function isManagedPluginPackageName(name: string) {
	return MANAGED_PLUGIN_PKG_RE.test(name)
}

function collectManifestDeps(manifest: unknown): Set<string> {
	const out = new Set<string>()
	if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return out
	const m = manifest as Record<string, unknown>
	for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies'] as const) {
		const rec = m[field]
		if (!rec || typeof rec !== 'object' || Array.isArray(rec)) continue
		for (const k of Object.keys(rec)) out.add(k)
	}
	return out
}

async function readWorkspaceRootDeclaredPluginDeps(rootDirAbs: string): Promise<Set<string>> {
	try {
		const raw = await readFile(resolve(rootDirAbs, 'package.json'), 'utf8')
		const json = JSON.parse(raw) as unknown
		return collectManifestDeps(json)
	} catch {
		return new Set<string>()
	}
}

export function mergeHmrProfile(
	cfg: PluxelHmrConfigV1,
	env?: Record<string, string | undefined>,
): MergedProfile {
	const activeProfile = env?.PLUXEL_HMR_PROFILE ?? cfg.profile
	const profile = cfg.profiles[activeProfile]
	if (!profile) {
		throw new Error(
			`[hmr] Unknown profile "${activeProfile}". Available: ${Object.keys(cfg.profiles).join(', ')}`,
		)
	}

	const roots = profile.roots ?? cfg.defaults?.roots ?? 'auto'
	const enabled = profile.enabled
	const builtinPackages = profile.builtin ?? []
	const includeGlobs = [...(cfg.defaults?.include ?? []), ...(profile.include ?? [])]
	const excludeGlobs = [...(cfg.defaults?.exclude ?? []), ...(profile.exclude ?? [])]

	return { activeProfile, roots, enabled, builtinPackages, includeGlobs, excludeGlobs }
}

export async function resolveHmrRootsExpanded(
	rootDir: string,
	roots: 'auto' | string[],
): Promise<string[]> {
	const base = resolve(rootDir)
	if (roots !== 'auto') return uniqSorted(roots.map((r) => toPosix(resolve(base, r))))

	const info = await loadWorkspaceInfo(base)
	const rootsAbs = uniqSorted(info.packageDirs.length ? info.packageDirs : [info.root])
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
	const dir = slash >= 0 ? trimmed.slice(0, slash) : '.'
	return resolve(rootDirAbs, dir)
}

async function resolveIncludeEntryFilesAbs(params: {
	rootDir: string
	includeGlobs: string[]
	excludeGlobs: string[]
}): Promise<string[]> {
	const rootDirAbs = resolve(params.rootDir)

	const includeAbs = params.includeGlobs.map((g) => toPosix(resolve(rootDirAbs, g)))
	if (!includeAbs.length) return []

	const excludeAbs = params.excludeGlobs.map((g) => toPosix(resolve(rootDirAbs, g)))
	const isIncluded = picomatch(includeAbs, { dot: true })
	const isExcluded = excludeAbs.length ? picomatch(excludeAbs, { dot: true }) : null

	const crawlRoots = uniqSorted(
		params.includeGlobs.map((p) => toPosix(resolveGlobBaseDir(rootDirAbs, p))),
	).filter((d) => existsSync(d))

	const out = new Set<string>()
	for (const root of crawlRoots) {
		const files = await crawlFilesAbs({
			roots: [root],
			ignoreDirNames: DEFAULT_IGNORED_DIR_NAMES,
			fileFilter: (p) =>
				p.endsWith('.ts') || p.endsWith('.tsx') || p.endsWith('.mts') || p.endsWith('.cts'),
		})

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
		if (file === dir || file.startsWith(prefix)) {
			if (!best || dir.length > best.dir.length) best = { name: p.name, dir }
		}
	}
	return best?.name ?? null
}

export async function buildWorkspaceSnapshotFromScan(params: {
	rootDir: string
	merged: MergedProfile
	rootsExpandedAbs: string[]
	packages: Array<{ name: string; deps: string[]; pkgDirAbs: string }>
	discovered: DiscoveredPlugin[]
	omitPackages?: string[]
}): Promise<DiagnoseWorkspaceResult> {
	const rootDirAbs = resolve(params.rootDir)
	const rootDeclaredDeps = await readWorkspaceRootDeclaredPluginDeps(rootDirAbs)

	const depsByName = new Map(params.packages.map((p) => [p.name, p.deps]))
	const discoveredSet = new Set(params.discovered.map((p) => p.name))

	const byPluginName = new Map<string, DiscoveredPlugin>()
	for (const p of params.discovered) byPluginName.set(p.name, p)

	const errors: string[] = []
	const enabledPackageEntriesAbs: string[] = []

	const omit = new Set((params.omitPackages ?? []).map((s) => String(s).trim()).filter(Boolean))
	const effectiveEnabled: string[] = []
	const skippedEnabled: string[] = []
	for (const name of params.merged.enabled) {
		if (omit.has(name)) {
			skippedEnabled.push(name)
			continue
		}
		effectiveEnabled.push(name)
	}

	for (const name of effectiveEnabled) {
		const plugin = byPluginName.get(name)
		if (!plugin) {
			errors.push(`[hmr] Enabled plugin not found: ${name}`)
			continue
		}
		const entryAbs = toPosix(resolve(rootDirAbs, plugin.entry))
		if (!existsSync(entryAbs)) {
			errors.push(`[hmr] Plugin entry missing on disk: ${name} -> ${plugin.entry}`)
			continue
		}
		enabledPackageEntriesAbs.push(entryAbs)
	}

	const includeEntryFilesAbs = await resolveIncludeEntryFilesAbs({
		rootDir: rootDirAbs,
		includeGlobs: params.merged.includeGlobs,
		excludeGlobs: params.merged.excludeGlobs,
	})
	const includedEntries = includeEntryFilesAbs.map((abs) => toRootRelative(rootDirAbs, abs))

	if (errors.length) return { ok: false, errors, discovered: params.discovered }

	const warnings: string[] = []
	if (skippedEnabled.length) {
		warnings.push(
			`[hmr] Skipped ${skippedEnabled.length} enabled package(s) because they are provided by builtins: ${skippedEnabled.join(
				', ',
			)}`,
		)
	}

	{
		// Monorepo correctness: if an enabled plugin package declares another plugin package as a dependency,
		// but that dependency is not enabled, the runtime may fail with MissingDependency during DI commit.
		const enabledSet = new Set(effectiveEnabled)
		const missingEdges: Array<{ from: string; missing: string[] }> = []
		for (const name of effectiveEnabled) {
			const deps = depsByName.get(name) ?? []
			const missing = deps
				.filter((d) => discoveredSet.has(d))
				.filter((d) => !enabledSet.has(d))
				.filter((d) => !omit.has(d))
			if (missing.length) missingEdges.push({ from: name, missing: uniqSorted(missing) })
		}
		if (missingEdges.length) {
			const maxEdges = 20
			const shown = missingEdges.slice(0, maxEdges)
			warnings.push(
				`[hmr] ${missingEdges.length} selected plugin package(s) depend on other plugin packages that are not selected in this profile. Consider adding them to profile.enabled to avoid MissingDependency when their plugins are enabled at runtime.`,
			)
			for (const edge of shown) {
				warnings.push(`[hmr] Missing profile packages: ${edge.from} -> ${edge.missing.join(', ')}`)
			}
			if (missingEdges.length > maxEdges) {
				warnings.push(`[hmr] …and ${missingEdges.length - maxEdges} more missing-deps edge(s).`)
			}
		}
	}
	{
		// PackageService correctness: managed plugin packages installed via node_modules are typically auto-loaded
		// only when they are declared in the workspace root manifest (see PackageService.syncTrackedPlugins()).
		//
		// When a selected workspace plugin package depends on a managed plugin package, but the root manifest does
		// not declare it, the plugin may be installed transitively yet never loaded into LoaderService (unless the
		// host explicitly loads it via PackageService or provides it as a builtin).
		const missingEdges: Array<{ from: string; missing: string[] }> = []
		for (const name of effectiveEnabled) {
			const deps = depsByName.get(name) ?? []
			const missing = deps
				.filter((d) => isManagedPluginPackageName(d))
				.filter((d) => !discoveredSet.has(d)) // not a workspace plugin package
				.filter((d) => !rootDeclaredDeps.has(d)) // not declared at workspace root
				.filter((d) => !omit.has(d))
			if (missing.length) missingEdges.push({ from: name, missing: uniqSorted(missing) })
		}

		if (missingEdges.length) {
			const maxEdges = 20
			warnings.push(
				`[hmr] ${missingEdges.length} selected plugin package(s) depend on managed (node_modules) plugin packages that are not declared in the workspace root package.json. If you rely on PackageService auto-load, add them to root deps (or load them manually / provide as builtins).`,
			)
			for (const edge of missingEdges.slice(0, maxEdges)) {
				warnings.push(
					`[hmr] Missing root deps (managed plugins): ${edge.from} -> ${edge.missing.join(', ')}`,
				)
			}
			if (missingEdges.length > maxEdges) {
				warnings.push(
					`[hmr] …and ${missingEdges.length - maxEdges} more missing managed-deps edge(s).`,
				)
			}
		}
	}

	if (effectiveEnabled.length === 0 && includeEntryFilesAbs.length === 0) {
		warnings.push('[hmr] No enabled plugins in active profile (start will do nothing useful).')
	}
	if (params.merged.includeGlobs.length && includeEntryFilesAbs.length === 0) {
		warnings.push('[hmr] include globs matched 0 files.')
	}

	const includePkgNames = uniqSorted(
		includeEntryFilesAbs
			.map((f) => findContainingWorkspacePackageName(f, params.packages))
			.filter((n): n is string => Boolean(n)),
	)
	const extraRootsAbs = uniqSorted(
		includeEntryFilesAbs
			.filter((f) => !findContainingWorkspacePackageName(f, params.packages))
			.map((f) => toPosix(resolve(f, '..'))),
	)

	const watchPackageNames = uniqSorted([...effectiveEnabled, ...includePkgNames])
	// Keep watchRoots minimal: only packages that contain enabled entries / include entries.
	// HMRService dynamically tracks dependency edits via the runner moduleGraph once modules are imported,
	// so we don't need a precomputed deps-closure here.
	const pkgDirByName = new Map(params.packages.map((p) => [p.name, p.pkgDirAbs]))
	const watchRootsAbs = uniqSorted([
		...watchPackageNames.map((n) => pkgDirByName.get(n)).filter((p): p is string => Boolean(p)),
		...extraRootsAbs,
	])

	const roots = params.rootsExpandedAbs.map((abs) => toRootRelative(rootDirAbs, abs))
	const watchRoots = watchRootsAbs.map((abs) => toRootRelative(rootDirAbs, abs))

	const enabledEntriesAbs = uniqPreserveOrder([
		...enabledPackageEntriesAbs,
		...includeEntryFilesAbs,
	])
	const enabledEntries = enabledEntriesAbs.map((abs) => toRootRelative(rootDirAbs, abs))

	const watchExts = ['ts', 'tsx', 'mts', 'cts'] as const
	const includeGlobs = uniqSorted([
		...watchRoots.flatMap((dir) => watchExts.map((ext) => `${dir}/**/*.${ext}`)),
		...params.merged.includeGlobs,
	])
	const excludeGlobs = uniqSorted(params.merged.excludeGlobs)

	if (excludeGlobs.length && enabledEntriesAbs.length) {
		const excludeAbs = excludeGlobs.map((g) => toPosix(resolve(rootDirAbs, g)))
		const isExcluded = picomatch(excludeAbs, { dot: true })
		for (const entry of enabledEntriesAbs) {
			if (isExcluded(entry))
				warnings.push(
					`[hmr] Startup entry is excluded by exclude globs: ${toRootRelative(rootDirAbs, entry)}`,
				)
		}
	}

	const snapshot: WorkspaceSnapshot = {
		activeProfile: params.merged.activeProfile,
		roots,
		enabled: effectiveEnabled,
		builtinPackages: uniqSorted(params.merged.builtinPackages),
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

	if (!existsSync(configPathAbs))
		return { ok: false, errors: [`Missing config file: ${configPathAbs}`] }

	let cfg: PluxelHmrConfigV1
	try {
		cfg = readHmrConfigV1(configPathAbs)
	} catch (error) {
		return { ok: false, errors: [error instanceof Error ? error.message : String(error)] }
	}

	let merged: MergedProfile
	try {
		merged = mergeHmrProfile(cfg, input.env)
	} catch (error) {
		return { ok: false, errors: [error instanceof Error ? error.message : String(error)] }
	}

	let rootsExpandedAbs: string[]
	try {
		rootsExpandedAbs = await resolveHmrRootsExpanded(rootDirAbs, merged.roots)
	} catch (error) {
		return { ok: false, errors: [error instanceof Error ? error.message : String(error)] }
	}

	const { packages } = await scanWorkspacePackages({
		rootDir: rootDirAbs,
		roots: rootsExpandedAbs,
		excludeGlobs: merged.excludeGlobs,
	})
	const discovered = discoverPluginsFromPackages(rootDirAbs, packages)

	const omitPackages = uniqSorted([
		...(input.omitPackages ?? []),
		...(merged.builtinPackages ?? []),
	])

	return await buildWorkspaceSnapshotFromScan({
		rootDir: rootDirAbs,
		merged,
		rootsExpandedAbs,
		packages: packages.map((p) => ({ name: p.name, deps: p.deps, pkgDirAbs: p.pkgDirAbs })),
		discovered,
		omitPackages: omitPackages.length ? omitPackages : undefined,
	})
}

export function resolveHmrConfigPathFromCwd(cwd = process.cwd()) {
	return resolveDefaultHmrConfigPath(cwd)
}
