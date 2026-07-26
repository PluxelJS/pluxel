import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { pluxelRuntimeSourceVitePlugins } from '@pluxel/rolldown/vite'
import { dirname, resolve } from 'pathe'
import { type InlineConfig, normalizePath, type Plugin, searchForWorkspaceRoot } from 'vite'
import {
	PLUXEL_CONDITION_HMR,
	PLUXEL_CONDITION_SOURCE,
	findNearestPackageRoot,
	getCachedResolver,
	getOxcResolveCache,
	pathVariantsAbs,
	resolveModulePath,
	toBasePackage,
} from '@pluxel/runtime/internal'
import { clientNodeImportGuardPlugin } from './plugins/clientNodeImportGuard'
import { DEFAULT_VITE_WATCH_IGNORED, VITE_WATCH_USE_POLLING } from '../vite-watch'

export interface LoaderHmrDependencies {
	bridgeModules: readonly string[]
	bridgeProviders: Readonly<Record<string, string>>
	cjsExternal: readonly string[]
}

/**
 * Modules that are required to be singletons between the host process and the runner.
 *
 * These are internal invariants rather than host configuration: changing the set can evaluate a
 * second Context/runtime implementation inside the runner.
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

const DEFAULT_SSR_NO_EXTERNAL = ['react', 'react-dom', ...REQUIRED_BRIDGE_MODULES] as const
const DEFAULT_CJS_EXTERNAL = ['pluxel-plugin-napi-rs/*', '@napi-rs/*'] as const
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
const DEFAULT_CLIENT_OPTIMIZE_DEPS_INTEROP = ['react', 'react-dom'] as const
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

const DEFAULT_LOADER_HMR_DEPENDENCIES: LoaderHmrDependencies = {
	bridgeModules: REQUIRED_BRIDGE_MODULES,
	bridgeProviders: REQUIRED_BRIDGE_PROVIDERS,
	cjsExternal: DEFAULT_CJS_EXTERNAL,
}

const mergeRequired = (required: readonly string[], extra?: readonly string[]) =>
	extra ? [...new Set([...required, ...extra])] : [...required]

export function resolveLoaderHmrDependencies(
	options: {
		cjsExternal?: readonly string[]
	} = {},
): LoaderHmrDependencies {
	return {
		...DEFAULT_LOADER_HMR_DEPENDENCIES,
		cjsExternal: mergeRequired(DEFAULT_CJS_EXTERNAL, options.cjsExternal),
	}
}

export function buildHmrResolveConditions(env = process.env.NODE_ENV): string[] {
	const extras = env && !DEFAULT_RESOLVE_CONDITIONS.includes(env) ? [env] : []
	return [
		...new Set([...BASE_LOADER_HMR_RESOLVE_CONDITIONS, ...DEFAULT_RESOLVE_CONDITIONS, ...extras]),
	]
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
	clientEntries?: string[]
	runnerPlugin: Plugin
	httpPlugin: Plugin
	port?: number
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
	const clientEntries = resolveClientEntries(opts.root, opts.clientEntries)
	const hasClientEntries = clientEntries.length > 0
	const dedupePackages = [...new Set([...REQUIRED_DEDUPE_PACKAGES, ...DEFAULT_CLIENT_DEDUPE])]

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
		server: {
			port: opts.port ?? 3000,
			middlewareMode: false,
			preTransformRequests: false,
			watch: {
				ignored: [...DEFAULT_VITE_WATCH_IGNORED],
				usePolling: VITE_WATCH_USE_POLLING,
			},
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
		optimizeDeps: hasClientEntries
			? {
					entries: clientEntries,
					include: [...DEFAULT_CLIENT_OPTIMIZE_DEPS_INCLUDE],
					needsInterop: [...DEFAULT_CLIENT_OPTIMIZE_DEPS_INTEROP],
					ignoreOutdatedRequests: true,
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
			noExternal: [...DEFAULT_SSR_NO_EXTERNAL],
			optimizeDeps: { noDiscovery: true, include: [], needsInterop: [] },
			resolve: {
				conditions: ssrConditions,
				dedupe: dedupePackages,
				preserveSymlinks: false,
			} as unknown as InlineConfig['resolve'],
		},
	}

	return internalConfig
}
