import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { pluxelRuntimeSourceVitePlugins } from '@pluxel/rolldown/vite'
import { dirname, resolve } from 'pathe'
import {
	createLogger,
	type InlineConfig,
	type Logger,
	normalizePath,
	type Plugin,
	mergeConfig,
	searchForWorkspaceRoot,
} from 'vite'
import {
	PLUXEL_CONDITION_HMR,
	PLUXEL_CONDITION_SOURCE,
	canResolveFromCwd,
	findNearestPackageRoot,
	getCachedResolver,
	getOxcResolveCache,
	pathVariantsAbs,
	resolveModulePath,
	toBasePackage,
} from '@pluxel/runtime/shared'
import { clientNodeImportGuardPlugin } from './plugins/clientNodeImportGuard'

export interface LoaderHmrDependencyConfig {
	/** Reuse host exports for these specifiers so class singletons survive HMR. */
	bridgeModules?: readonly string[]
	/**
	 * Map a "logical" bridge module specifier to the host module that actually provides it.
	 *
	 * Motivation:
	 * Some workspaces intentionally bundle/inline modules like `@pluxel/context` into `@pluxel/core`.
	 * In that setup, importing `@pluxel/context` as a separate host module would evaluate a second
	 * implementation and trip singleton guards.
	 *
	 * When present, the runner:
	 * - imports the provider module from the host runtime,
	 * - primes the runner cache under the original specifier,
	 * - and maps `runner.import(<specifier>)` → `runner.import(<provider>)`.
	 */
	bridgeProviders?: Record<string, string>
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

export interface ResolvedLoaderHmrDependencyConfig {
	bridgeModules: readonly string[]
	bridgeProviders: Readonly<Record<string, string>>
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
	'@pluxel/context',
	'@pluxel/core',
	'@pluxel/core/services',
	'@pluxel/runtime',
	'@pluxel/runtime/internal',
	'@pluxel/runtime/web',
	'@pluxel/runtime/capnweb',
] as const

const REQUIRED_BRIDGE_PROVIDERS = Object.freeze({
	'@pluxel/context': '@pluxel/core',
} satisfies Record<string, string>)

const REQUIRED_DEDUPE_PACKAGES = [
	...new Set([...REQUIRED_BRIDGE_MODULES.map(toBasePackage), '@pluxel/rolldown']),
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
const DEFAULT_CLIENT_DEDUPE = [
	'react',
	'react-dom',
	'@mantine/core',
	'@mantine/hooks',
	'@mantine/notifications',
	'@mantine/dates',
] as const
const DEFAULT_CLIENT_OPTIMIZE_DEPS_INCLUDE = [
	'react',
	'react-dom',
	'react/jsx-runtime',
	'react-dom/client',
	'@mantine/core',
	'@mantine/hooks',
	'@mantine/notifications',
	'@tabler/icons-react',
] as const
const moduleDir = dirname(fileURLToPath(import.meta.url))

function resolveOptionalPackageEntry(specifier: string): string | null {
	const resolver = getCachedResolver(
		getOxcResolveCache(),
		'hmr:optional-package-entry-resolver',
		[moduleDir],
		{ limit: 8 },
	)
	const resolved = resolveModulePath(resolver, specifier, {
		conditions: ['import', 'module', 'browser', 'default'],
	})
	return resolved ? normalizePath(resolved) : null
}

const TABLER_ICONS_ESM_ENTRY = resolveOptionalPackageEntry(
	'@tabler/icons-react/dist/esm/icons/index.mjs',
)

// Prefer workspace TS sources for SSR runner (monorepo/hmr).
// NOTE: We must exclude these conditions from the client environment to avoid resolving Node-only sources.
export const BASE_LOADER_HMR_RESOLVE_CONDITIONS = [
	PLUXEL_CONDITION_HMR,
	PLUXEL_CONDITION_SOURCE,
] as const
// Keep `import` explicitly: Vite's exports resolution depends on it for packages that only expose `import`/`require`.
const DEFAULT_RESOLVE_CONDITIONS = [
	'import',
	'module',
	'browser',
	'development',
	'production',
	'default',
]

export const DEFAULT_LOADER_HMR_DEPENDENCY_CONFIG: ResolvedLoaderHmrDependencyConfig = {
	bridgeModules: REQUIRED_BRIDGE_MODULES,
	bridgeProviders: REQUIRED_BRIDGE_PROVIDERS,
	ssrExternal: DEFAULT_SSR_EXTERNAL,
	ssrNoExternal: DEFAULT_SSR_NO_EXTERNAL,
	cjsExternal: DEFAULT_CJS_EXTERNAL,
	optimizeDepsInclude: DEFAULT_OPTIMIZE_DEPS_INCLUDE,
	optimizeDepsInterop: DEFAULT_OPTIMIZE_DEPS_INTEROP,
}

const mergeRequired = (required: readonly string[], extra?: readonly string[]) =>
	extra ? [...new Set([...required, ...extra])] : [...required]

export function resolveLoaderHmrDependencyConfig(
	overrides?: LoaderHmrDependencyConfig,
	opts?: { cwd?: string; resolveCache?: Map<string, unknown> },
): ResolvedLoaderHmrDependencyConfig {
	const cwd = opts?.cwd ?? process.cwd()
	const resolveCache = getOxcResolveCache(opts?.resolveCache)

	if (!overrides) {
		const bridgeProviders = mergeBridgeProviders(
			REQUIRED_BRIDGE_PROVIDERS,
			autoDetectBridgeProviders(cwd, REQUIRED_BRIDGE_MODULES, resolveCache),
		)
		return {
			...DEFAULT_LOADER_HMR_DEPENDENCY_CONFIG,
			bridgeModules: mergeRequired(
				REQUIRED_BRIDGE_MODULES,
				Object.values(bridgeProviders).filter(
					(v): v is string => typeof v === 'string' && v.length > 0,
				),
			),
			bridgeProviders: Object.freeze(bridgeProviders),
		}
	}

	const bridgeModules = mergeRequired(REQUIRED_BRIDGE_MODULES, overrides.bridgeModules)
	const bridgeProviders = mergeBridgeProviders(
		mergeBridgeProviders(
			REQUIRED_BRIDGE_PROVIDERS,
			autoDetectBridgeProviders(cwd, bridgeModules, resolveCache),
		),
		overrides.bridgeProviders,
	)
	const bridgeModulesWithProviders = mergeRequired(
		bridgeModules,
		Object.values(bridgeProviders).filter(
			(v): v is string => typeof v === 'string' && v.length > 0,
		),
	)

	return {
		bridgeModules: bridgeModulesWithProviders,
		bridgeProviders: Object.freeze(bridgeProviders),
		ssrExternal: overrides.ssrExternal ?? DEFAULT_SSR_EXTERNAL,
		// Required singleton modules must never be removable; they are part of HMR invariants.
		ssrNoExternal: mergeRequired(DEFAULT_SSR_NO_EXTERNAL, overrides.ssrNoExternal),
		cjsExternal: overrides.cjsExternal ?? DEFAULT_CJS_EXTERNAL,
		optimizeDepsInclude: overrides.optimizeDepsInclude ?? DEFAULT_OPTIMIZE_DEPS_INCLUDE,
		optimizeDepsInterop: overrides.optimizeDepsInterop ?? DEFAULT_OPTIMIZE_DEPS_INTEROP,
	}
}

export function buildHmrResolveConditions(env = process.env.NODE_ENV): string[] {
	const extras = env && !DEFAULT_RESOLVE_CONDITIONS.includes(env) ? [env] : []
	return [
		...new Set([...BASE_LOADER_HMR_RESOLVE_CONDITIONS, ...DEFAULT_RESOLVE_CONDITIONS, ...extras]),
	]
}

function mergeBridgeProviders(
	base: Record<string, string>,
	overrides: LoaderHmrDependencyConfig['bridgeProviders'] | Record<string, string> | undefined,
): Record<string, string> {
	const out: Record<string, string> = { ...base }
	if (overrides && typeof overrides === 'object') {
		for (const [k, v] of Object.entries(overrides)) {
			if (!k || typeof k !== 'string') continue
			if (!v || typeof v !== 'string') continue
			out[k] = v
		}
	}
	return out
}

function autoDetectBridgeProviders(
	cwd: string,
	bridgeModules: readonly string[],
	resolveCache: Map<string, unknown>,
): Record<string, string> {
	// If the host workspace does not install `@pluxel/context`, but HMR still treats it as a bridge module,
	// we assume it is provided by `@pluxel/core` (bundled/embedded) and bridge via core.
	//
	// This avoids accidentally importing a second `@pluxel/context` implementation via HMR's own node_modules.
	if (!bridgeModules.includes('@pluxel/context')) return {}
	if (canResolveFromCwd(cwd, '@pluxel/context', resolveCache, { group: 'hmr:host-resolver' }))
		return {}
	if (!canResolveFromCwd(cwd, '@pluxel/core', resolveCache, { group: 'hmr:host-resolver' }))
		return {}
	return { '@pluxel/context': '@pluxel/core' }
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
		for (const v of pathVariantsAbs(dir)) allow.add(v)
		const pkgRoot = findNearestPackageRoot(dir)
		if (pkgRoot) packageRoots.add(pkgRoot)
	}
	for (const pkgRoot of packageRoots) {
		for (const v of pathVariantsAbs(pkgRoot)) allow.add(v)
		const pkgNodeModules = normalizePath(resolve(pkgRoot, 'node_modules'))
		if (existsSync(pkgNodeModules)) allow.add(pkgNodeModules)
	}
	if (Array.isArray(opts.configFsAllow)) {
		for (const extra of opts.configFsAllow) {
			const resolved = normalizePath(resolve(opts.cwd, extra))
			for (const v of pathVariantsAbs(resolved)) allow.add(v)
		}
	}
	return [...allow]
}

export interface HmrViteConfigOptions {
	root: string
	fsAllow: string[]
	deps: ResolvedLoaderHmrDependencyConfig
	clientEntries?: string[]
	vite?: InlineConfig
	runnerPlugin: Plugin
	httpPlugin: Plugin
	port?: number
	optimizeDepsEnabled?: boolean
	ssrOptimizeDepsEnabled?: boolean
	cacheDir?: string
}

function resolveClientEntries(root: string, entries?: readonly string[]): string[] {
	if (entries?.length) {
		return entries.map((entry) => normalizePath(resolve(root, entry)))
	}

	const defaultEntry = resolve(root, 'src/client.tsx')
	return existsSync(defaultEntry) ? [normalizePath(defaultEntry)] : []
}

export function buildLoaderHmrViteConfig(opts: HmrViteConfigOptions): InlineConfig {
	const ssrConditions = buildHmrResolveConditions()
	// The HMR server hosts BOTH:
	// - a browser UI (client environment)
	// - a server-side runner (ssr environment)
	//
	// Pluxel source conditions are server-only (workspace TS sources, Node-only deps).
	// If we forward it into the client environment, Vite may resolve packages like
	// `@pluxel/wretch` (or any runner-only plugin) to `./src/...` and then try to analyze/optimize Node-only imports
	// (e.g. `undici`) as if they were browser deps.
	const clientConditions = ssrConditions.filter(
		(c) => c !== PLUXEL_CONDITION_HMR && c !== PLUXEL_CONDITION_SOURCE,
	)
	// Default: avoid dep optimization churn in Vite 8 beta.
	// Opt-in via config when you want "fastest steady-state" for the UI/runner.
	const optimizeDepsEnabled = opts.optimizeDepsEnabled === true
	const ssrOptimizeDepsEnabled = opts.ssrOptimizeDepsEnabled === true
	const clientEntries = resolveClientEntries(opts.root, opts.clientEntries)
	const hasClientEntries = clientEntries.length > 0
	// Prefer Vite's default cacheDir (`<root>/node_modules/.vite`) because sharing a single cache
	// across different hosts/roots can cause "update deps" metadata mismatches in Vite 8 beta.
	// If callers want a shared cache, they can still opt-in explicitly via config.
	const cacheDir = opts.cacheDir
	const dedupePackages = [
		...new Set([
			...REQUIRED_DEDUPE_PACKAGES,
			...DEFAULT_CLIENT_DEDUPE,
			...opts.deps.bridgeModules.map(toBasePackage),
		]),
	]
	const clientOptimizeDepsInclude = [
		...new Set([...DEFAULT_CLIENT_OPTIMIZE_DEPS_INCLUDE, ...opts.deps.optimizeDepsInclude]),
	]

	type LoggerWithOnce = Logger & {
		infoOnce: (msg: string, options?: unknown) => void
		warnOnce: (msg: string, options?: unknown) => void
	}

	const baseLogger = createLogger(undefined, { prefix: '[pluxel-runtime]' }) as LoggerWithOnce
	// Avoid `{...baseLogger}` here: Vite mutates `logger.hasWarned`, and spreading would copy a stale boolean.
	// We only override warning output to silence known-noisy Vite import-analysis warnings.
	const customLogger = Object.create(baseLogger) as LoggerWithOnce
	customLogger.info = (msg: string, options?: unknown) => {
		if (shouldSilenceOptimizeDepsInfo(msg)) return
		baseLogger.info(msg, options)
	}
	customLogger.infoOnce = (msg: string, options?: unknown) => {
		if (shouldSilenceOptimizeDepsInfo(msg)) return
		if (baseLogger.infoOnce) baseLogger.infoOnce(msg, options)
		else baseLogger.info(msg, options)
	}
	customLogger.warn = (msg: string, options?: unknown) => {
		if (shouldSilenceDynamicImportWarning(msg)) return
		if (shouldSilenceSourcemapMissingWarning(msg)) return
		baseLogger.warn(msg, options)
	}
	customLogger.warnOnce = (msg: string, options?: unknown) => {
		if (shouldSilenceDynamicImportWarning(msg)) return
		if (shouldSilenceSourcemapMissingWarning(msg)) return
		if (baseLogger.warnOnce) baseLogger.warnOnce(msg, options)
		else baseLogger.warn(msg, options)
	}

	const internalAliases = TABLER_ICONS_ESM_ENTRY
		? [
				{
					find: /^@tabler\/icons-react$/,
					replacement: TABLER_ICONS_ESM_ENTRY,
				},
			]
		: []

	const internalConfig: InlineConfig = {
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
			alias: internalAliases,
			conditions: clientConditions,
			dedupe: dedupePackages,
			// Ensure linked workspaces resolve to real filesystem paths so the runner does not
			// evaluate the same physical file under both symlink and realpath ids.
			preserveSymlinks: false,
			// Vite 8: built-in tsconfig paths support.
			// (We intentionally avoid `vite-tsconfig-paths` to keep behavior consistent across environments.)
			tsconfigPaths: true,
		} as unknown as InlineConfig['resolve'],
		environments: {
			ssr: {
				resolve: {
					alias: internalAliases,
					conditions: ssrConditions,
					dedupe: dedupePackages,
					preserveSymlinks: false,
				} as unknown as InlineConfig['resolve'],
			},
		},
		plugins: [
			clientNodeImportGuardPlugin(),
			...pluxelRuntimeSourceVitePlugins({
				name: 'pluxel:dynamic-runtime-source',
				root: opts.root,
			}),
			opts.runnerPlugin,
			opts.httpPlugin,
		],
		// Performance-first HMR host: keep optimizer mostly off by default.
		// Vite 8: `optimizeDeps.disabled` is deprecated.
		//
		// For browser entries, enable deterministic crawling from the served entry sources.
		// This avoids first-load races where Vite emits optimized dep URLs before they exist on disk.
		optimizeDeps: optimizeDepsEnabled
			? {
					entries: clientEntries,
					include: clientOptimizeDepsInclude,
					needsInterop: [...opts.deps.optimizeDepsInterop],
					ignoreOutdatedRequests: true,
					holdUntilCrawlEnd: true,
				}
			: hasClientEntries
				? {
						entries: clientEntries,
						include: clientOptimizeDepsInclude,
						needsInterop: [...opts.deps.optimizeDepsInterop],
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
			noExternal: [...opts.deps.ssrNoExternal],
			external: [...opts.deps.ssrExternal],
			optimizeDeps: ssrOptimizeDepsEnabled
				? {
						// Make CJS-only dependencies safer to consume from TS/ESM plugin sources:
						// Vite can pre-bundle & interop CJS deps for SSR when they are not externalized.
						// (externalized deps are handled by Vite/Node runtime, including require-only exports in many cases.)
						noDiscovery: true,
						include: [...opts.deps.optimizeDepsInclude],
						needsInterop: [...opts.deps.optimizeDepsInterop],
					}
				: { noDiscovery: true, include: [], needsInterop: [] },
			resolve: {
				conditions: ssrConditions,
				dedupe: dedupePackages,
				preserveSymlinks: false,
			} as unknown as InlineConfig['resolve'],
		},
	}

	return mergeConfig(internalConfig, opts.vite ?? {})
}

function shouldSilenceDynamicImportWarning(msg: string): boolean {
	// Vite import-analysis warns on dynamic import patterns it can't statically analyze.
	// We intentionally use them in a few server-only places (runner/package loader).
	if (!msg.includes('The above dynamic import cannot be analyzed by Vite.')) return false
	return (
		msg.includes('/packages/runtime-dynamic/') ||
		msg.includes('\\packages\\runtime-dynamic\\') ||
		msg.includes('/node_modules/@pluxel/runtime-dynamic/') ||
		msg.includes('\\node_modules\\@pluxel\\runtime-dynamic\\')
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
