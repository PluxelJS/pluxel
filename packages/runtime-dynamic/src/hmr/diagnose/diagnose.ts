import { resolve } from 'pathe'
import picomatch from 'picomatch'
import type { BuiltinsFromDistEntry, LoaderHmrWorkspaceSnapshot } from '../snapshot'
import {
	type PluxelLoaderHmrConfigV1,
	readLoaderHmrConfigV1,
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
	readTextFile,
	type LoaderHmrWorkspaceFs,
	type WorkspaceFs,
} from './fs'

export type DiagnoseWorkspaceInput = {
	rootDir: string
	configPath: string
	env?: Record<string, string | undefined>
	/**
	 * Package names to omit from discovery/enabled resolution.
	 *
	 * Primary use case: the host preloads certain packages as builtins (baseline),
	 * so workspace profiles should not also load their `@pluxel/runtime-dynamic` source entries
	 * (prevents "plugin name conflict" from double-loading the same package).
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
	builtinPackages: string[]
	includeGlobs: string[]
	excludeGlobs: string[]
}

const MANAGED_PLUGIN_PKG_RE = /^(?:@[^/]+\/)?pluxel-plugin-/i

function isManagedPluginPackageName(name: string) {
	return MANAGED_PLUGIN_PKG_RE.test(name)
}

function resolveDefaultDistEntryFromManifest(manifest: unknown): string | null {
	if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return null
	const exportsField = (manifest as Record<string, unknown>).exports
	const dot =
		exportsField && typeof exportsField === 'object' && !Array.isArray(exportsField)
			? (exportsField as Record<string, unknown>)['.']
			: undefined
	if (!dot) return null

	// Intentional simplification (no compat burden): builtin packages must provide a direct dist ESM entry.
	// We only accept a string `.mjs` at `exports["."].import|default|module` or `exports["."]` itself.
	const pick = (v: unknown) =>
		typeof v === 'string' && v.trim().endsWith('.mjs') ? v.trim() : null
	if (typeof dot === 'string') return pick(dot)
	if (typeof dot !== 'object' || Array.isArray(dot)) return null
	const obj = dot as Record<string, unknown>
	return pick(obj.import) ?? pick(obj.default) ?? pick(obj.module)
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

async function readWorkspaceRootDeclaredPluginDeps(
	rootDirAbs: string,
	fs: WorkspaceFs = nodeWorkspaceFs,
): Promise<Set<string>> {
	try {
		const raw = await readTextFile(fs, resolve(rootDirAbs, 'package.json'))
		const json = JSON.parse(raw) as unknown
		return collectManifestDeps(json)
	} catch {
		return new Set<string>()
	}
}

export function mergeLoaderHmrProfile(
	cfg: PluxelLoaderHmrConfigV1,
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
	const builtinPackages = profile.builtin ?? []
	const includeGlobs = [...(cfg.defaults?.include ?? []), ...(profile.include ?? [])]
	const excludeGlobs = [...(cfg.defaults?.exclude ?? []), ...(profile.exclude ?? [])]

	return { activeProfile, roots, enabled, builtinPackages, includeGlobs, excludeGlobs }
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
	const rootDeclaredDeps = await readWorkspaceRootDeclaredPluginDeps(rootDirAbs, params.fs)
	const fs = params.fs ?? nodeWorkspaceFs

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
	if (skippedEnabled.length > 0) {
		warnings.push(
			`[loader-hmr] Skipped ${skippedEnabled.length} enabled package(s) because they are provided by builtins: ${skippedEnabled.join(
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
			if (missing.length > 0) missingEdges.push({ from: name, missing: uniqSorted(missing) })
		}
		if (missingEdges.length > 0) {
			const maxEdges = 20
			const shown = missingEdges.slice(0, maxEdges)
			warnings.push(
				`[loader-hmr] ${missingEdges.length} selected plugin package(s) depend on other plugin packages that are not selected in this profile. Consider adding them to profile.enabled to avoid MissingDependency when their plugins are enabled at runtime.`,
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
			if (missing.length > 0) missingEdges.push({ from: name, missing: uniqSorted(missing) })
		}

		if (missingEdges.length > 0) {
			const maxEdges = 20
			warnings.push(
				`[loader-hmr] ${missingEdges.length} selected plugin package(s) depend on managed (node_modules) plugin packages that are not declared in the workspace root package.json. If you rely on PackageService auto-load, add them to root deps (or load them manually / provide as builtins).`,
			)
			for (const edge of missingEdges.slice(0, maxEdges)) {
				warnings.push(
					`[loader-hmr] Missing root deps (managed plugins): ${edge.from} -> ${edge.missing.join(', ')}`,
				)
			}
			if (missingEdges.length > maxEdges) {
				warnings.push(
					`[loader-hmr] …and ${missingEdges.length - maxEdges} more missing managed-plugin edge(s).`,
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

	// Watch roots: enabled plugin package dirs + include-containing package + non-package include dirs.
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
	const fs = input.fs ?? nodeLoaderHmrWorkspaceFs

	if (!fs.existsSync(configPathAbs))
		return { ok: false, errors: [`Missing config file: ${configPathAbs}`] }

	let cfg: PluxelLoaderHmrConfigV1
	try {
		cfg = readLoaderHmrConfigV1(configPathAbs, fs)
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

	const omitPackages = uniqSorted([
		...(input.omitPackages ?? []),
		...(merged.builtinPackages ?? []),
	])

	const base = await buildWorkspaceSnapshotFromScan({
		rootDir: rootDirAbs,
		merged,
		rootsExpandedAbs,
		packages: packages.map((p) => ({ name: p.name, deps: p.deps, pkgDirAbs: p.pkgDirAbs })),
		discovered,
		omitPackages: omitPackages.length > 0 ? omitPackages : undefined,
		fs,
	})

	if (!base.ok) return base

	const builtinPkgs = base.snapshot.builtinPackages
	if (builtinPkgs.length === 0) return base

	const byName = new Map(packages.map((p) => [p.name, p]))
	const builtinsFromDist: BuiltinsFromDistEntry[] = []
	for (const pkgName of builtinPkgs) {
		const pkg = byName.get(pkgName)
		if (!pkg)
			return {
				ok: false,
				errors: [`[loader-hmr] Builtin package not found in workspace: ${pkgName}`],
				discovered: base.snapshot.discovered,
			}

		const rel = resolveDefaultDistEntryFromManifest(pkg.manifest)
		if (!rel) {
			return {
				ok: false,
				errors: [
					`[loader-hmr] Builtin package missing dist .mjs export entry (check package.json exports): ${pkgName}`,
				],
				discovered: base.snapshot.discovered,
			}
		}

		const entryAbs = resolve(pkg.pkgDirAbs, rel)
		if (!fs.existsSync(entryAbs)) {
			return {
				ok: false,
				errors: [`[loader-hmr] Builtin dist entry missing on disk for ${pkgName}: ${entryAbs}`],
				discovered: base.snapshot.discovered,
			}
		}

		builtinsFromDist.push({ packageName: pkgName, entry: toRootRelative(rootDirAbs, entryAbs) })
	}

	return { ok: true, snapshot: { ...base.snapshot, builtinsFromDist }, warnings: base.warnings }
}

export function resolveLoaderHmrConfigPathFromCwd(cwd = process.cwd()) {
	return resolveDefaultLoaderHmrConfigPath(cwd)
}
