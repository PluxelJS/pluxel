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
