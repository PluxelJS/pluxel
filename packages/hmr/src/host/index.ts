import { existsSync } from 'node:fs'
import { copyFile, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
	DEFAULT_HMR_CONFIG_BASENAME,
	diagnoseWorkspace,
	type WorkspaceSnapshot,
} from '@pluxel/cli/hmr'
import type { Plugin as VitePlugin } from 'vite'
import { Context } from '..'
import type { EnsurePluxelLoggingOptions } from '../logger/ensure'
import { ensurePluxelLogging } from '../logger/ensure'
import type { HMRDependencyConfig } from '../services/runtime/hmr/config'
import type { HMRConfig } from '../services/runtime/hmr/HMRService'
import type { BuiltinPluginSpec } from '../services/runtime/loader/LoaderService'

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
	 * Plugin scan roots (workspace-relative).
	 *
	 * When omitted, this is resolved from `pluxel.hmr.jsonc` via workspace profiles.
	 */
	roots?: string[]
	/**
	 * Workspace profiles config file path.
	 *
	 * Defaults to `pluxel.hmr.jsonc` under `root`.
	 */
	configPath?: string
	/**
	 * Profile override for this run.
	 *
	 * Equivalent to setting `PLUXEL_HMR_PROFILE` for discovery.
	 */
	profile?: string
	/**
	 * Workspace snapshot (preferred): skips discovery.
	 *
	 * When absent and `entries` is not provided, `createHmrHost()` resolves it from config.
	 */
	workspaceSnapshot?: WorkspaceSnapshot
	/**
	 * Override HMR include globs (absolute or workspace-relative).
	 *
	 * When provided, HMR will only treat matching files as in-scope (plus anchors).
	 */
	include?: string[]
	/**
	 * Override cold-start entry modules.
	 *
	 * Use this when an outer layer already resolved enabled plugins + include entries to a stable list.
	 */
	entries?: string[]
	/**
	 * Extra exclude globs for HMR scanning (workspace-relative or absolute).
	 *
	 * When workspace profiles are used, this is appended to profile exclude globs.
	 */
	exclude?: string[]
	/**
	 * Builtin plugin constructors (preloaded baseline).
	 *
	 * Defaults to `[]`.
	 */
	builtins?: readonly BuiltinPluginSpec[]
	/**
	 * Enable warmup (best-effort background).
	 *
	 * Defaults to `true`.
	 */
	warmup?: boolean
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
	ctx: Context
}

/**
 * Map a small set of env vars into `hmrService` config.
 *
 * Intentionally minimal:
 * - Deployment: `CLIENT_DIST` → `hmrService.publicBase`
 * - Profiling: `PLUXEL_HMR_ATTRIBUTION` → `hmrService.attribution`
 *
 * Everything else should be configured explicitly in code to avoid "invisible" behavior changes.
 */
export function applyHmrEnvOverrides(base: HMRConfig, env = process.env): HMRConfig {
	const out: HMRConfig = { ...base }

	// Keep env overrides intentionally minimal: only allow "generic" deployment/profiling flags.
	if (env.CLIENT_DIST) out.publicBase = env.CLIENT_DIST

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

	return out
}

function uniqSorted(list: readonly string[]) {
	return [...new Set(list)].sort((a, b) => a.localeCompare(b))
}

async function resolveSnapshotFromConfig(params: {
	root: string
	configPath?: string
	profile?: string
	omitPackages?: string[]
}): Promise<WorkspaceSnapshot> {
	const configPathAbs = resolve(params.root, params.configPath ?? DEFAULT_HMR_CONFIG_BASENAME)
	const env = params.profile ? { ...process.env, PLUXEL_HMR_PROFILE: params.profile } : process.env
	const res = await diagnoseWorkspace({
		rootDir: params.root,
		configPath: configPathAbs,
		env,
		omitPackages: params.omitPackages,
	})
	if (!res.ok) {
		const hint = `Hint: run \`pluxel hmr\` (interactive) to generate/edit ${configPathAbs}.`
		throw new Error([...res.errors, hint].join('\n'))
	}
	return res.snapshot
}

function extractBuiltinPackageNames(builtins: readonly BuiltinPluginSpec[]): string[] {
	const out: string[] = []
	for (const spec of builtins) {
		if (typeof spec === 'function') continue
		const pkg = typeof spec.packageName === 'string' ? spec.packageName.trim() : ''
		if (pkg) {
			out.push(pkg)
			continue
		}
		// Back-compat: some call sites used `moduleId` as the workspace package name.
		const moduleId = typeof spec.moduleId === 'string' ? spec.moduleId.trim() : ''
		if (moduleId && !moduleId.includes(':')) out.push(moduleId)
	}
	return uniqSorted(out)
}

export async function createHmrHost(opts: CreateHmrHostOptions = {}): Promise<CreateHmrHostResult> {
	const root = resolve(opts.root ?? process.cwd())
	if (opts.chdir !== false) process.chdir(root)

	const logsDir = resolve(root, opts.logsDir ?? 'logs')
	await mkdir(logsDir, { recursive: true })

	const debug = opts.debug ?? ['pluxel:hmr:*']

	const logging = opts.logging ?? true
	if (logging) {
		const base: EnsurePluxelLoggingOptions =
			typeof logging === 'object' ? { ...logging } : { preset: 'hmr' }
		await ensurePluxelLogging({
			preset: base.preset ?? 'hmr',
			file: base.file ?? opts.logFile ?? join(logsDir, 'hmr.log'),
			ui: base.ui ?? true,
			debug: base.debug ?? debug,
		})
	}

	const deps: HMRDependencyConfig | undefined = opts.cjsExternal?.length
		? { ...(opts.deps ?? {}), cjsExternal: opts.cjsExternal }
		: opts.deps

	const builtins = opts.builtins ?? []
	const omitPackages = builtins.length ? extractBuiltinPackageNames(builtins) : undefined

	const snapshot =
		opts.workspaceSnapshot ??
		(!opts.entries
			? await resolveSnapshotFromConfig({
					root,
					configPath: opts.configPath,
					profile: opts.profile,
					omitPackages,
				})
			: null)

	const roots = opts.roots ?? snapshot?.watchRoots
	if (!roots || roots.length === 0) {
		throw new Error(
			`[hmr-host] Missing roots: provide opts.roots, or add workspace profiles config at ${resolve(root, opts.configPath ?? DEFAULT_HMR_CONFIG_BASENAME)}.`,
		)
	}

	const include = snapshot
		? uniqSorted([...(snapshot.includeGlobs ?? []), ...(opts.include ?? [])])
		: opts.include
	const exclude = snapshot
		? uniqSorted([...(snapshot.excludeGlobs ?? []), ...(opts.exclude ?? [])])
		: (opts.exclude ?? [])
	const entries = opts.entries ?? snapshot?.enabledEntries
	if (!entries) {
		throw new Error(
			`[hmr-host] Missing entries: provide opts.entries or configure workspace profiles at ${resolve(root, opts.configPath ?? DEFAULT_HMR_CONFIG_BASENAME)}.`,
		)
	}

	const hmrServiceBase: HMRConfig = {
		roots,
		warmup: opts.warmup ?? true,
		include,
		entries,
		exclude,
		builtins,
		vitePlugins: opts.vitePlugins,
		deps,
	}
	const hmrService = applyHmrEnvOverrides(hmrServiceBase)

	const contextExtra: Record<string, unknown> = { ...(opts.context ?? {}) }

	if (opts.store) {
		const configFile = opts.store.configFile ?? '.pluxel/hmr/config.json'
		const resolvedConfigPath = resolve(root, configFile)
		await mkdir(dirname(resolvedConfigPath), { recursive: true })
		const seed = opts.store.seedConfig
		if (seed !== false && !existsSync(resolvedConfigPath)) {
			const seedPath = resolve(root, seed ?? 'default.json')
			if (existsSync(seedPath)) await copyFile(seedPath, resolvedConfigPath)
		}
		// ConfigService reads `ctx.config.path` (top-level), not `ctx.config.config.path`.
		contextExtra.path = resolvedConfigPath
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
	} satisfies Context.Config

	const ctx = new Context(ctxConfig)

	return { root, logsDir, ctx }
}

export async function startHmrHost(
	opts: CreateHmrHostOptions = {},
): Promise<CreateHmrHostResult & { started: true }> {
	const res = await createHmrHost(opts)
	await res.ctx.root.hmrService.start()
	return { ...res, started: true }
}
