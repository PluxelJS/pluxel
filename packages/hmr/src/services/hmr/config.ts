import { existsSync } from 'node:fs'
import { configSourcePlugin, importTypeFixerPlugin } from '@pluxel/rolldown'
import { resolve } from 'pathe'
import Macros from 'unplugin-macros/rolldown'
import type { InlineConfig, Plugin } from 'vite'
import { normalizePath, searchForWorkspaceRoot } from 'vite'
import tsconfigPaths from 'vite-tsconfig-paths'
import { findNearestPackageRoot } from './internals'

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

export const BASE_HMR_RESOLVE_CONDITIONS = ['@pluxel/hmr', '@pluxel/source', 'source'] as const
const DEFAULT_RESOLVE_CONDITIONS = ['module', 'browser', 'development', 'production', 'default']

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
	scanDirs: string[]
	deps: ResolvedHMRDependencyConfig
	runnerPlugin: Plugin
	honoPlugin: Plugin
	port?: number
}

export function buildHmrViteConfig(opts: HmrViteConfigOptions): InlineConfig {
	const conditions = buildHmrResolveConditions()
	return {
		root: opts.root,
		server: {
			port: opts.port ?? 3000,
			middlewareMode: false,
			fs: {
				allow: opts.fsAllow,
			},
		},
		resolve: {
			conditions,
		},
		plugins: [
			tsconfigPaths(),
			configSourcePlugin({ include: opts.scanDirs.map((d) => `${d}/**/*.{ts,tsx}`) }),
			importTypeFixerPlugin(),
			Macros(),
			opts.runnerPlugin,
			opts.honoPlugin,
		],
		optimizeDeps: {
			force: true,
			include: Array.from(opts.deps.optimizeDepsInclude),
			needsInterop: Array.from(opts.deps.optimizeDepsInterop),
		},
		ssr: {
			noExternal: Array.from(opts.deps.ssrNoExternal),
			external: Array.from(opts.deps.ssrExternal),
			// Make CJS-only dependencies safer to consume from TS/ESM plugin sources:
			// Vite can pre-bundle & interop CJS deps for SSR when they are not externalized.
			// (externalized deps are handled by Vite/Node runtime, including require-only exports in many cases.)
			optimizeDeps: {
				include: Array.from(opts.deps.optimizeDepsInclude),
				needsInterop: Array.from(opts.deps.optimizeDepsInterop),
			},
			resolve: {
				conditions,
			},
		},
	}
}
