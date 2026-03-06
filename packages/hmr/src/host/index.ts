import { existsSync } from 'node:fs'
import { copyFile, mkdir } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'pathe'
import type { Plugin as VitePlugin } from 'vite'
import type { Context as PluxelContext } from '..'
import { BasicAuthBuiltinPlugin } from '../builtins/BasicAuthBuiltinPlugin'
import { diagnoseWorkspace, resolveDefaultHmrConfigPath } from '../diagnose'
import type { EnsurePluxelLoggingOptions } from '../logger/ensure'
import type { HMRDependencyConfig } from '../services/runtime/hmr/config'
import type { HMRConfig } from '../services/runtime/hmr/HMRService'
import type { BuiltinPluginSpec } from '../services/runtime/loader/LoaderService'
import { assertHmrWorkspaceSnapshot, type HmrWorkspaceSnapshot } from '../snapshot'

export type CreateHmrHostOptions = {
	/**
	 * Workspace root directory.
	 *
	 * Defaults to `process.cwd()`.
	 */
	root?: string
	/**
	 * Whether to `process.chdir(root)` before creating Context (recommended).
	 *
	 * Defaults to `true`.
	 */
	chdir?: boolean
	/**
	 * Debug topic patterns.
	 *
	 * Defaults to `['pluxel:hmr:*']`.
	 */
	debug?: readonly string[]
	/**
	 * Workspace snapshot (required): the host does not perform discovery.
	 */
	workspaceSnapshot: HmrWorkspaceSnapshot
	/**
	 * Optional snapshot post-processor.
	 *
	 * Useful for callers that want to tweak include/exclude/entries without duplicating discovery.
	 */
	snapshotPatch?: (snapshot: HmrWorkspaceSnapshot) => HmrWorkspaceSnapshot
	/**
	 * Builtin plugin constructors (preloaded baseline).
	 *
	 * Defaults to `[]`.
	 */
	builtins?: readonly BuiltinPluginSpec[]
	/**
	 * Builtin plugins loaded from workspace package dist entries.
	 *
	 * When omitted, `createHmrHost()` derives this from `workspaceSnapshot.builtinsFromDist`
	 * (typically computed by the caller during workspace diagnosis).
	 * Set to `[]` to explicitly disable loading builtins-from-dist.
	 */
	builtinsFromDist?: HMRConfig['builtinsFromDist']
	/**
	 * Enable warmup (best-effort background).
	 *
	 * Defaults to `true`.
	 */
	warmup?: boolean
	/**
	 * Whether to print Vite dev server URLs on startup.
	 *
	 * Defaults to `true`.
	 */
	printUrls?: boolean
	/**
	 * Extra Vite plugins for the HMR dev server (macros, transforms, etc.).
	 */
	vitePlugins?: VitePlugin[]
	/**
	 * Dependency rules (CJS externals / bridge modules / optimizeDeps).
	 */
	deps?: HMRDependencyConfig
	/** Shortcut for `deps.cjsExternal`. */
	cjsExternal?: readonly string[]
	/**
	 * Log setup helper.
	 *
	 * - `true` / omitted: configure with defaults (file + UI sink)
	 * - `false`: do nothing (assume host configured LogTape elsewhere)
	 * - object: forwarded to `ensurePluxelLogging`
	 */
	logging?: boolean | EnsurePluxelLoggingOptions
	/**
	 * Log directory (workspace-relative unless absolute).
	 *
	 * Defaults to `<root>/logs`.
	 */
	logsDir?: string
	/**
	 * Log file path used when `logging` is enabled and `logging.file` is not provided.
	 *
	 * Defaults to `<logsDir>/hmr.log`.
	 */
	logFile?: string
	/**
	 * Runtime storage locations (recommended for templates).
	 *
	 * When provided, this keeps runtime state out of git-tracked `data/`.
	 */
	store?: {
		/**
		 * ConfigService storage file (workspace-relative unless absolute).
		 *
		 * Defaults to `.pluxel/hmr/config.json` when `store` is present.
		 *
		 * Tip: use `{profile}` to control where the active profile lands, e.g.
		 * `.pluxel/hmr/config.{profile}.json` or `.pluxel/hmr/{profile}/config.json`.
		 */
		configFile?: string
		/**
		 * Seed config file copied into `configFile` when the target doesn't exist.
		 *
		 * Example: `seedConfig: "default.json"`.
		 */
		seedConfig?: string | false
		/**
		 * PluginDataService storage dir (workspace-relative unless absolute).
		 *
		 * Defaults to `.pluxel/plugin-data` when `store` is present.
		 */
		pluginDataDir?: string
	}
	/**
	 * Pass-through: `registry` config for Context.
	 *
	 * This is intentionally loose (it depends on @pluxel/core config shape).
	 */
	registry?: Record<string, unknown>
	/**
	 * Pass-through: any additional Context config fields (advanced).
	 *
	 * This merges shallowly into the final `new Context(...)` config.
	 */
	context?: Record<string, unknown>
}

export type CreateHmrHostResult = {
	root: string
	logsDir: string
	ctx: PluxelContext
}

export type StartHmrHostFromConfigOptions = Omit<CreateHmrHostOptions, 'workspaceSnapshot'> & {
	/**
	 * HMR config file path.
	 *
	 * - When absolute: used as-is.
	 * - When relative: resolved against `root`.
	 * - When omitted: defaults to `<root>/pluxel.hmr.jsonc`.
	 */
	configPath?: string
	/**
	 * Override profile selection without mutating `process.env`.
	 *
	 * Equivalent to setting `env.PLUXEL_HMR_PROFILE`.
	 */
	profile?: string
	/**
	 * Extra environment variables forwarded to `diagnoseWorkspace()`.
	 *
	 * These are merged on top of `process.env` and `profile`.
	 */
	env?: Record<string, string | undefined>
	/** Forwarded to `diagnoseWorkspace()` as `omitPackages`. */
	omitPackages?: string[]
}

export type StartHmrHostFromConfigResult = CreateHmrHostResult & {
	started: true
	snapshot: HmrWorkspaceSnapshot
	warnings: string[]
}

export type CreateHmrHostFromConfigResult = CreateHmrHostResult & {
	snapshot: HmrWorkspaceSnapshot
	warnings: string[]
}

export async function createHmrHostFromConfig(
	opts: StartHmrHostFromConfigOptions,
): Promise<CreateHmrHostFromConfigResult> {
	const { configPath, profile, env: envOverrides, omitPackages, ...hostOpts } = opts

	const rootDir = resolve(process.cwd(), hostOpts.root ?? '.')
	const configPathAbs = (() => {
		if (configPath) return isAbsolute(configPath) ? configPath : resolve(rootDir, configPath)
		return resolveDefaultHmrConfigPath(rootDir)
	})()
	const env: Record<string, string | undefined> = {
		...process.env,
		...(profile ? { PLUXEL_HMR_PROFILE: profile } : {}),
		...(envOverrides ?? {}),
	}

	const res = await diagnoseWorkspace({
		rootDir,
		configPath: configPathAbs,
		env,
		omitPackages,
	})
	if (!res.ok) {
		throw new Error(res.errors.join('\n'))
	}

	const host = await createHmrHost({
		...hostOpts,
		root: rootDir,
		workspaceSnapshot: res.snapshot,
	})

	return { ...host, snapshot: res.snapshot, warnings: res.warnings }
}

export async function startHmrHostFromConfig(
	opts: StartHmrHostFromConfigOptions,
): Promise<StartHmrHostFromConfigResult> {
	const res = await createHmrHostFromConfig(opts)
	await res.ctx.root.hmrService.start()
	return { ...res, started: true }
}

/**
 * Map a small set of env vars into `hmrService` config.
 *
 * Intentionally minimal:
 * - Port: `PLUXEL_HMR_PORT` → `hmrService.port`
 * - Profiling: `PLUXEL_HMR_ATTRIBUTION` → `hmrService.attribution`
 * - Resilience: `PLUXEL_HMR_BUILTINS_PRELOAD_STRICT` / `PLUXEL_HMR_BUILTINS_AUTO_DISABLE_MISSING_DEPS`
 *
 * Everything else should be configured explicitly in code to avoid "invisible" behavior changes.
 */
export function applyHmrEnvOverrides(base: HMRConfig, env = process.env): HMRConfig {
	const out: HMRConfig = { ...base }

	const portRaw = env.PLUXEL_HMR_PORT
	if (portRaw !== undefined) {
		const n = Number(String(portRaw).trim())
		if (Number.isFinite(n) && n >= 0) out.port = Math.floor(n)
	}

	const attributionRaw = env.PLUXEL_HMR_ATTRIBUTION
	if (attributionRaw !== undefined) {
		if (attributionRaw === '0' || attributionRaw === 'false') out.attribution = false
		else if (attributionRaw === '1' || attributionRaw === 'true') out.attribution = true
		else if (
			attributionRaw === 'trace' ||
			attributionRaw === 'debug' ||
			attributionRaw === 'info' ||
			attributionRaw === 'warn' ||
			attributionRaw === 'error' ||
			attributionRaw === 'fatal'
		) {
			out.attribution = attributionRaw
		} else {
			out.attribution = true
		}
	}

	const builtinsStrictRaw = env.PLUXEL_HMR_BUILTINS_PRELOAD_STRICT
	if (builtinsStrictRaw !== undefined) {
		out.builtinsPreloadStrict =
			builtinsStrictRaw === '1' || builtinsStrictRaw === 'true' || builtinsStrictRaw === 'yes'
	}
	const autoDisableRaw = env.PLUXEL_HMR_BUILTINS_AUTO_DISABLE_MISSING_DEPS
	if (autoDisableRaw !== undefined) {
		out.builtinsAutoDisableMissingDependencies = !(
			autoDisableRaw === '0' ||
			autoDisableRaw === 'false' ||
			autoDisableRaw === 'no'
		)
	}
	const maxPassesRaw = env.PLUXEL_HMR_BUILTINS_AUTO_DISABLE_MAX_PASSES
	if (maxPassesRaw !== undefined) {
		const n = Number(maxPassesRaw)
		if (Number.isFinite(n) && n >= 0) out.builtinsAutoDisableMaxPasses = Math.floor(n)
	}

	return out
}

function uniqSorted(list: readonly string[]) {
	return [...new Set(list)].sort((a, b) => a.localeCompare(b))
}

function resolveBuiltinsFromDistEntries(
	rootDirAbs: string,
	list: ReadonlyArray<{ packageName: string; entry: string; exportKey?: string; enable?: boolean }>,
) {
	// Keep entries robust: accept root-relative/relative and normalize to absolute paths.
	return list
		.map((b) => ({
			...b,
			packageName: String(b.packageName ?? '').trim(),
			entry: (() => {
				const raw = String(b.entry ?? '').trim()
				if (!raw) return raw
				return isAbsolute(raw) ? raw : resolve(rootDirAbs, raw)
			})(),
		}))
		.filter((b) => b.packageName && b.entry)
}

export async function createHmrHost(opts: CreateHmrHostOptions): Promise<CreateHmrHostResult> {
	const root = resolve(opts.root ?? process.cwd())
	if (opts.chdir !== false) process.chdir(root)

	const logsDir = resolve(root, opts.logsDir ?? 'logs')
	const debug = opts.debug ?? ['pluxel:hmr:*']

	const logging = opts.logging ?? true
	if (logging) {
		await mkdir(logsDir, { recursive: true })
		const base: EnsurePluxelLoggingOptions = typeof logging === 'object' ? { ...logging } : {}
		const { ensurePluxelLogging } = await import('../logger/ensure')
		await ensurePluxelLogging({
			preset: base.preset ?? 'hmr',
			console: base.console,
			file: base.file ?? opts.logFile ?? join(logsDir, 'hmr.log'),
			ui: base.ui ?? true,
			debug: base.debug ?? debug,
		})
	}

	const deps: HMRDependencyConfig | undefined = opts.cjsExternal?.length
		? { ...(opts.deps ?? {}), cjsExternal: opts.cjsExternal }
		: opts.deps

	const userBuiltins = opts.builtins ?? []
	const builtins: readonly BuiltinPluginSpec[] = [
		{ plugin: BasicAuthBuiltinPlugin, enable: false },
		...userBuiltins,
	]
	let snapshot = opts.workspaceSnapshot
	// Runtime guard for JS callers / `any` escapes.
	if (!snapshot)
		throw new Error(
			'[hmr-host] workspaceSnapshot is required (compute it in your caller, e.g. via @pluxel/hmr/diagnose)',
		)
	if (opts.snapshotPatch) snapshot = opts.snapshotPatch(snapshot)
	assertHmrWorkspaceSnapshot(snapshot)

	const roots = snapshot.watchRoots
	const entries = snapshot.enabledEntries
	const include = snapshot.includeGlobs
	const exclude = snapshot.excludeGlobs

	let builtinsFromDist = opts.builtinsFromDist
	if (builtinsFromDist === undefined && opts.builtins === undefined) {
		builtinsFromDist = snapshot.builtinsFromDist?.length ? snapshot.builtinsFromDist : undefined
	}
	const builtinsFromDistResolved = builtinsFromDist?.length
		? resolveBuiltinsFromDistEntries(root, builtinsFromDist)
		: undefined

	const hmrServiceBase: HMRConfig = {
		roots,
		printUrls: opts.printUrls ?? true,
		warmup: opts.warmup ?? true,
		include: include?.length ? uniqSorted(include) : undefined,
		entries,
		exclude: exclude?.length ? uniqSorted(exclude) : undefined,
		builtins,
		...(builtinsFromDistResolved?.length ? { builtinsFromDist: builtinsFromDistResolved } : {}),
		vitePlugins: opts.vitePlugins,
		deps,
	}
	const hmrService = applyHmrEnvOverrides(hmrServiceBase)

	const contextExtra: Record<string, unknown> = { ...(opts.context ?? {}) }
	if (!('hmrProfile' in contextExtra)) contextExtra.hmrProfile = snapshot.activeProfile

	if (opts.store) {
		const configFile = opts.store.configFile ?? '.pluxel/hmr/config.json'
		// For filesystem operations (mkdir/seed), use the resolved *effective* path.
		// For Context, keep the template so ConfigService can apply `{profile}` itself.
		const configFileEffective = configFile.includes('{profile}')
			? configFile.replaceAll('{profile}', snapshot.activeProfile)
			: configFile
		const resolvedConfigPath = resolve(root, configFileEffective)
		await mkdir(dirname(resolvedConfigPath), { recursive: true })
		const seed = opts.store.seedConfig
		if (seed !== false && !existsSync(resolvedConfigPath)) {
			const seedPath = resolve(root, seed ?? 'default.json')
			if (existsSync(seedPath)) await copyFile(seedPath, resolvedConfigPath)
		}
		// ConfigService reads `ctx.config.path` (top-level), not `ctx.config.config.path`.
		contextExtra.path = resolve(root, configFile)
	}

	if (opts.store) {
		const pluginDataDir = opts.store.pluginDataDir ?? '.pluxel/plugin-data'
		const pluginData = (contextExtra.pluginData as Record<string, unknown> | undefined) ?? {}
		contextExtra.pluginData = { ...pluginData, dir: resolve(root, pluginDataDir) }
	}

	const ctxConfig = {
		debug,
		hmrService,
		registry: opts.registry,
		...contextExtra,
	} satisfies PluxelContext.Config

	// Only load `@pluxel/hmr` runtime (and its side effects) when we actually start a host.
	await import('../context-augment')
	const { Context } = await import('..')
	const ctx = new Context(ctxConfig)

	return { root, logsDir, ctx }
}

export async function startHmrHost(
	opts: CreateHmrHostOptions,
): Promise<CreateHmrHostResult & { started: true }> {
	const res = await createHmrHost(opts)
	await res.ctx.root.hmrService.start()
	return { ...res, started: true }
}
