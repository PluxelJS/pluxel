export interface HMRDependencyConfig {
	/** Reuse host exports for these specifiers so class singletons survive HMR. */
	bridgeModules?: readonly string[]
	/** Packages that vite-node should never try to inline/transform. */
	runnerExternal?: ReadonlyArray<string | RegExp>
	/** Forwarded to Vite's ssr.external to keep core runtime modules untouched. */
	ssrExternal?: readonly string[]
	/** Forwarded to Vite's ssr.noExternal to make sure React stack stays bundled. */
	ssrNoExternal?: readonly string[]
	/** optimizeDeps.include white-list. */
	optimizeDepsInclude?: readonly string[]
	/** optimizeDeps.needsInterop white-list. */
	optimizeDepsInterop?: readonly string[]
}

export interface ResolvedHMRDependencyConfig {
	bridgeModules: readonly string[]
	runnerExternal: ReadonlyArray<string | RegExp>
	ssrExternal: readonly string[]
	ssrNoExternal: readonly string[]
	optimizeDepsInclude: readonly string[]
	optimizeDepsInterop: readonly string[]
}

const DEFAULT_BRIDGE_MODULES = [
	'@pluxel/core',
	'@pluxel/core/services',
	'@pluxel/hmr',
	'@pluxel/hmr/services',
	'@pluxel/hmr/config',
	'@pluxel/hmr/web',
	'@pluxel/hmr/capnweb',
] as const

const DEFAULT_RUNNER_EXTERNAL: ReadonlyArray<string | RegExp> = [
	/^(react|react-dom|lodash|dayjs)(\/|$)/,
	...DEFAULT_BRIDGE_MODULES,
]

const DEFAULT_SSR_EXTERNAL = DEFAULT_BRIDGE_MODULES
const DEFAULT_SSR_NO_EXTERNAL = ['react', 'react-dom'] as const
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
	bridgeModules: DEFAULT_BRIDGE_MODULES,
	runnerExternal: DEFAULT_RUNNER_EXTERNAL,
	ssrExternal: DEFAULT_SSR_EXTERNAL,
	ssrNoExternal: DEFAULT_SSR_NO_EXTERNAL,
	optimizeDepsInclude: DEFAULT_OPTIMIZE_DEPS_INCLUDE,
	optimizeDepsInterop: DEFAULT_OPTIMIZE_DEPS_INTEROP,
}

export function resolveHMRDependencyConfig(
	overrides?: HMRDependencyConfig,
): ResolvedHMRDependencyConfig {
	if (!overrides) return DEFAULT_HMR_DEPENDENCY_CONFIG

	return {
		bridgeModules: overrides.bridgeModules ?? DEFAULT_BRIDGE_MODULES,
		runnerExternal: overrides.runnerExternal ?? DEFAULT_RUNNER_EXTERNAL,
		ssrExternal: overrides.ssrExternal ?? DEFAULT_SSR_EXTERNAL,
		ssrNoExternal: overrides.ssrNoExternal ?? DEFAULT_SSR_NO_EXTERNAL,
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
			resolve: {
				conditions,
			},
		},
	}
}

import { configSourcePlugin, importTypeFixerPlugin } from '@pluxel/rolldown'
import type { InlineConfig, Plugin } from 'vite'
import { normalizePath, searchForWorkspaceRoot } from 'vite'
import { existsSync } from 'node:fs'
import { resolve } from 'pathe'
import { findNearestPackageRoot } from './internals'
import tsconfigPaths from 'vite-tsconfig-paths'
