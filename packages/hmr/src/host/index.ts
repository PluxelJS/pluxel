import { existsSync } from 'node:fs'
import { copyFile, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import type { Plugin as VitePlugin } from 'vite'

import { Context } from '..'
import type { EnsurePluxelLoggingOptions } from '../logger/ensure'
import { ensurePluxelLogging } from '../logger/ensure'
import type { HMRDependencyConfig } from '../services/hmr/config'
import type { HMRConfig } from '../services/hmr/HMRService'
import type { BuiltinPluginSpec } from '../services/loader/LoaderService'

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
	 * Defaults to `['chatbots','render-plugins','plugins','.']`, filtered by existence.
	 */
	roots?: string[]
	/**
	 * Extra exclude globs for HMR scanning (workspace-relative or absolute).
	 *
	 * Defaults to `['builtin-plugins/**']`.
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

function defaultScanRoots(root: string): string[] {
	const candidates = ['chatbots', 'render-plugins', 'plugins', '.']
	return candidates.filter((dir) => existsSync(join(root, dir)))
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

	const roots = opts.roots ?? defaultScanRoots(root)
	const hmrServiceBase: HMRConfig = {
		roots,
		warmup: opts.warmup ?? true,
		exclude: opts.exclude ?? ['builtin-plugins/**'],
		builtins: opts.builtins ?? [],
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
	await res.ctx.hmrService.start()
	return { ...res, started: true }
}
