import { existsSync } from 'node:fs'
// Use the public CLI facade; it re-exports internal build plugins without exposing @pluxel/build directly.
import { configSourceVitePlugin, importTypeFixerVitePlugin } from '@pluxel/cli/rolldown'
import { resolve } from 'pathe'
import {
	createLogger,
	type InlineConfig,
	type Logger,
	normalizePath,
	type Plugin,
	perEnvironmentPlugin,
	searchForWorkspaceRoot,
} from 'vite'
import { findNearestPackageRoot } from './internals'
import { clientNodeImportGuardPlugin } from './plugins/clientNodeImportGuard'

export interface HMRDependencyConfig {
	/** Reuse host exports for these specifiers so class singletons survive HMR. */
	bridgeModules?: readonly string[]
	/** Forwarded to Vite's ssr.external to keep core runtime modules untouched. */
	ssrExternal?: readonly string[]
	/** Forwarded to Vite's ssr.noExternal to make sure React stack stays bundled. */
	ssrNoExternal?: readonly string[]
	/**
	 * Force externalization for known CommonJS-only packages (or prefixes), to avoid runner crashes like
	 * "require is not defined" when Vite tries to inline/evaluate them as ESM.
	 *
	 * Supported patterns:
	 * - exact: `cjs-pkg`
	 * - prefix: `@napi-rs/*` matches `@napi-rs/canvas`, `@napi-rs/xxx`
	 */
	cjsExternal?: readonly string[]
	/** optimizeDeps.include white-list. */
	optimizeDepsInclude?: readonly string[]
	/** optimizeDeps.needsInterop white-list. */
	optimizeDepsInterop?: readonly string[]
}

export interface ResolvedHMRDependencyConfig {
	bridgeModules: readonly string[]
	ssrExternal: readonly string[]
	ssrNoExternal: readonly string[]
	cjsExternal: readonly string[]
	optimizeDepsInclude: readonly string[]
	optimizeDepsInterop: readonly string[]
}

/**
 * Modules that are required to be singletons between the host process and the runner.
 *
 * NOTE:
 * These are intentionally NOT removable via user config. Users may only append additional bridge
 * modules for their own runtime singletons.
 */
const REQUIRED_BRIDGE_MODULES = [
	'@pluxel/core',
	'@pluxel/core/services',
	'@pluxel/context',
	'@pluxel/hmr',
	'@pluxel/hmr/services',
	'@pluxel/hmr/config',
	'@pluxel/hmr-web',
	'@pluxel/hmr/web',
	'@pluxel/hmr/capnweb',
] as const

const DEFAULT_SSR_NO_EXTERNAL_BASE = ['react', 'react-dom'] as const

/**
 * IMPORTANT:
 * - Modules listed in `ssr.external` are loaded by the host runtime (native import/require), bypassing
 *   Vite's ModuleRunner evaluation pipeline.
 * - For workspace packages that must share singletons with the host (decorators, BasePlugin, DI tokens),
 *   we generally want them to go through the runner so we can bridge/cache them deterministically.
 */
const DEFAULT_SSR_EXTERNAL: readonly string[] = []
const DEFAULT_SSR_NO_EXTERNAL = [
	...DEFAULT_SSR_NO_EXTERNAL_BASE,
	...REQUIRED_BRIDGE_MODULES,
] as const
const DEFAULT_CJS_EXTERNAL = ['pluxel-plugin-napi-rs/*', '@napi-rs/*'] as const
const DEFAULT_OPTIMIZE_DEPS_INCLUDE = [
	'react',
	'react-dom',
	'react/jsx-runtime',
	'react-dom/client',
] as const
const DEFAULT_OPTIMIZE_DEPS_INTEROP = ['react', 'react-dom'] as const

// Prefer workspace TS sources for SSR runner (monorepo/dev).
// NOTE: We must exclude these conditions from the client environment to avoid resolving Node-only sources.
export const BASE_HMR_RESOLVE_CONDITIONS = ['@pluxel/hmr', '@pluxel/source'] as const
// Keep `import` explicitly: Vite's exports resolution depends on it for packages that only expose `import`/`require`.
const DEFAULT_RESOLVE_CONDITIONS = [
	'import',
	'module',
	'browser',
	'development',
	'production',
	'default',
]

export const DEFAULT_HMR_DEPENDENCY_CONFIG: ResolvedHMRDependencyConfig = {
	bridgeModules: REQUIRED_BRIDGE_MODULES,
	ssrExternal: DEFAULT_SSR_EXTERNAL,
	ssrNoExternal: DEFAULT_SSR_NO_EXTERNAL,
	cjsExternal: DEFAULT_CJS_EXTERNAL,
	optimizeDepsInclude: DEFAULT_OPTIMIZE_DEPS_INCLUDE,
	optimizeDepsInterop: DEFAULT_OPTIMIZE_DEPS_INTEROP,
}

const mergeRequired = (required: readonly string[], extra?: readonly string[]) =>
	extra ? [...new Set([...required, ...extra])] : [...required]

export function resolveHMRDependencyConfig(
	overrides?: HMRDependencyConfig,
): ResolvedHMRDependencyConfig {
	if (!overrides) return DEFAULT_HMR_DEPENDENCY_CONFIG

	return {
		bridgeModules: mergeRequired(REQUIRED_BRIDGE_MODULES, overrides.bridgeModules),
		ssrExternal: overrides.ssrExternal ?? DEFAULT_SSR_EXTERNAL,
		ssrNoExternal: overrides.ssrNoExternal ?? DEFAULT_SSR_NO_EXTERNAL,
		cjsExternal: overrides.cjsExternal ?? DEFAULT_CJS_EXTERNAL,
		optimizeDepsInclude: overrides.optimizeDepsInclude ?? DEFAULT_OPTIMIZE_DEPS_INCLUDE,
		optimizeDepsInterop: overrides.optimizeDepsInterop ?? DEFAULT_OPTIMIZE_DEPS_INTEROP,
	}
}

export function buildHmrResolveConditions(env = process.env.NODE_ENV): string[] {
	const extras = env && !DEFAULT_RESOLVE_CONDITIONS.includes(env) ? [env] : []
	return [...new Set([...BASE_HMR_RESOLVE_CONDITIONS, ...DEFAULT_RESOLVE_CONDITIONS, ...extras])]
}

export interface FsAllowOptions {
	cwd: string
	cwdNormalized: string
	scanRoots: string[]
	configFsAllow?: string[]
	hmrPackageRoot?: string | null
}

export function resolveFsAllowList(opts: FsAllowOptions): string[] {
	const allow = new Set<string>()
	const workspaceRoot = searchForWorkspaceRoot(opts.cwd)
	if (workspaceRoot) allow.add(normalizePath(workspaceRoot))
	allow.add(opts.cwdNormalized)
	if (opts.hmrPackageRoot) allow.add(opts.hmrPackageRoot)
	const packageRoots = new Set<string>()
	for (const dir of opts.scanRoots) {
		allow.add(dir)
		const pkgRoot = findNearestPackageRoot(dir)
		if (pkgRoot) packageRoots.add(pkgRoot)
	}
	for (const pkgRoot of packageRoots) {
		allow.add(pkgRoot)
		const pkgNodeModules = normalizePath(resolve(pkgRoot, 'node_modules'))
		if (existsSync(pkgNodeModules)) allow.add(pkgNodeModules)
	}
	if (Array.isArray(opts.configFsAllow)) {
		for (const extra of opts.configFsAllow) {
			allow.add(normalizePath(resolve(opts.cwd, extra)))
		}
	}
	return [...allow]
}

export interface HmrViteConfigOptions {
	root: string
	fsAllow: string[]
	scanRoots: string[]
	deps: ResolvedHMRDependencyConfig
	extraPlugins?: Plugin[]
	runnerPlugin: Plugin
	honoPlugin: Plugin
	port?: number
	includeGlobs?: string[]
	excludeGlobs?: string[]
	optimizeDepsEnabled?: boolean
	ssrOptimizeDepsEnabled?: boolean
	cacheDir?: string
}

export function buildHmrViteConfig(opts: HmrViteConfigOptions): InlineConfig {
	const ssrConditions = buildHmrResolveConditions()
	// The HMR dev server hosts BOTH:
	// - a browser UI (client environment)
	// - a server-side runner (ssr environment)
	//
	// `@pluxel/hmr` is a *server-only* export condition (workspace TS sources, Node-only deps).
	// If we forward it into the client environment, Vite may resolve packages like
	// `@pluxel/wretch` (or any runner-only plugin) to `./src/...` and then try to analyze/optimize Node-only imports
	// (e.g. `undici`) as if they were browser deps.
	const clientConditions = ssrConditions.filter(
		(c) => c !== '@pluxel/hmr' && c !== '@pluxel/source',
	)
	const includePatterns = opts.includeGlobs ?? opts.scanRoots.map((d) => `${d}/**/*.ts`)
	// Default: avoid dep optimization churn in Vite 8 beta.
	// Opt-in via config when you want "fastest steady-state" for the UI/runner.
	const optimizeDepsEnabled = opts.optimizeDepsEnabled === true
	const ssrOptimizeDepsEnabled = opts.ssrOptimizeDepsEnabled === true
	const isUiRoot = existsSync(resolve(opts.root, 'src/client.tsx'))
	// Prefer Vite's default cacheDir (`<root>/node_modules/.vite`) because sharing a single cache
	// across different hosts/roots can cause "update deps" metadata mismatches in Vite 8 beta.
	// If callers want a shared cache, they can still opt-in explicitly via config.
	const cacheDir = opts.cacheDir

	const baseLogger = createLogger(undefined, { prefix: '[pluxel-hmr]' })
	// Avoid `{...baseLogger}` here: Vite mutates `logger.hasWarned`, and spreading would copy a stale boolean.
	// We only override warning output to silence known-noisy Vite import-analysis warnings.
	const customLogger = Object.create(baseLogger) as Logger
	customLogger.info = (msg, options) => {
		if (shouldSilenceOptimizeDepsInfo(msg)) return
		baseLogger.info(msg, options)
	}
	customLogger.infoOnce = (msg, options) => {
		if (shouldSilenceOptimizeDepsInfo(msg)) return
		baseLogger.infoOnce(msg, options)
	}
	customLogger.warn = (msg, options) => {
		if (shouldSilenceDynamicImportWarning(msg)) return
		if (shouldSilenceSourcemapMissingWarning(msg)) return
		baseLogger.warn(msg, options)
	}
	customLogger.warnOnce = (msg, options) => {
		if (shouldSilenceDynamicImportWarning(msg)) return
		if (shouldSilenceSourcemapMissingWarning(msg)) return
		baseLogger.warnOnce(msg, options)
	}

	return {
		root: opts.root,
		cacheDir,
		customLogger,
		server: {
			port: opts.port ?? 3000,
			middlewareMode: false,
			preTransformRequests: false,
			fs: {
				allow: opts.fsAllow,
			},
		},
		resolve: {
			conditions: clientConditions,
			// Vite 8: built-in tsconfig paths support.
			// (We intentionally avoid `vite-tsconfig-paths` to keep behavior consistent across environments.)
			tsconfigPaths: true,
		},
		environments: {
			ssr: {
				resolve: {
					conditions: ssrConditions,
				},
			},
		},
		plugins: [
			clientNodeImportGuardPlugin(),
			// NOTE:
			// Vite 8 may use Rolldown internally, but its dev server plugin container still consumes
			// Rollup/Vite hooks. Do NOT register native Rolldown plugins here (they won't run).
			// Use the explicit Vite wrappers from `@pluxel/cli/rolldown` (public facade).
			perEnvironmentPlugin('pluxel:ssr-transform', (environment) => {
				if (environment.name !== 'ssr') return false
				return [
					configSourceVitePlugin({ include: includePatterns, exclude: opts.excludeGlobs }),
					importTypeFixerVitePlugin({ include: includePatterns, exclude: opts.excludeGlobs }),
				]
			}),
			...(opts.extraPlugins ?? []),
			opts.runnerPlugin,
			opts.honoPlugin,
		],
		// Performance-first dev host: keep optimizer mostly off by default.
		// Vite 8: `optimizeDeps.disabled` is deprecated.
		//
		// For the HMR UI (`src/client.tsx` exists), enable minimal crawling from the UI entry.
		// This avoids first-load races where Vite emits optimized dep URLs before they exist on disk.
		optimizeDeps: optimizeDepsEnabled
			? {}
			: isUiRoot
				? {
						entries: ['src/client.tsx'],
						ignoreOutdatedRequests: true,
						// Avoid a first-load race where Vite emits optimized dep URLs before they exist on disk.
						holdUntilCrawlEnd: true,
					}
				: {
						noDiscovery: true,
						include: [],
						needsInterop: [],
						ignoreOutdatedRequests: true,
						holdUntilCrawlEnd: false,
					},
		ssr: {
			noExternal: Array.from(opts.deps.ssrNoExternal),
			external: Array.from(opts.deps.ssrExternal),
			optimizeDeps: ssrOptimizeDepsEnabled
				? {
						// Make CJS-only dependencies safer to consume from TS/ESM plugin sources:
						// Vite can pre-bundle & interop CJS deps for SSR when they are not externalized.
						// (externalized deps are handled by Vite/Node runtime, including require-only exports in many cases.)
						noDiscovery: true,
						include: Array.from(opts.deps.optimizeDepsInclude),
						needsInterop: Array.from(opts.deps.optimizeDepsInterop),
					}
				: { noDiscovery: true, include: [], needsInterop: [] },
			resolve: {
				conditions: ssrConditions,
			},
		},
	}
}

function shouldSilenceDynamicImportWarning(msg: string): boolean {
	// Vite import-analysis warns on dynamic import patterns it can't statically analyze.
	// We intentionally use them in a few server-only places (runner/market loader).
	if (!msg.includes('The above dynamic import cannot be analyzed by Vite.')) return false
	return (
		msg.includes('/packages/hmr/') ||
		msg.includes('\\packages\\hmr\\') ||
		msg.includes('/node_modules/@pluxel/hmr/') ||
		msg.includes('\\node_modules\\@pluxel\\hmr\\')
	)
}

function shouldSilenceOptimizeDepsInfo(msg: string): boolean {
	// Vite emits this when it thinks config/lockfile changed between runs.
	// In our HMR host, dep optimization is typically disabled or empty, so this is mostly noise.
	return msg.includes('Re-optimizing dependencies because vite config has changed')
}

function shouldSilenceSourcemapMissingWarning(msg: string): boolean {
	// Vite emits this when a dependency ships sourcemap references to unpublished sources.
	// It's noisy and does not affect runtime.
	return msg.includes('Sourcemap for "') && msg.includes('points to missing source files')
}
