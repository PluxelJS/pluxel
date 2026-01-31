import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { configSourcePlugin, importTypeFixerPlugin } from '@pluxel/build/rolldown'
import { defineConfig, mergeConfig, type UserConfig, type UserConfigExport } from 'vitest/config'

export type PluxelVitestOptions = {
	/** Include patterns for configSource extraction (default: only src/tests). */
	include?: string | string[]
	/** Exclude patterns for configSource extraction. */
	exclude?: string | string[]
	/**
	 * Extra Vite plugins to run BEFORE Pluxel toolchain plugins.
	 *
	 * Useful when your test suite needs an additional transform that should apply to source
	 * before `configSourcePlugin` runs.
	 */
	prePlugins?: NonNullable<UserConfig['plugins']>
}

export const PLUXEL_BASE_RESOLVE_CONDITIONS = ['@pluxel/source', '@pluxel/hmr'] as const

const DEFAULT_NODE_RESOLVE_CONDITIONS = [
	// Prefer Node-friendly exports in tests.
	'node',
	// Keep `import` explicitly: Vite's exports resolution depends on it for packages that only expose `import`/`require`.
	'import',
	'module',
	'development',
	'production',
	'default',
	// Keep `browser` last; it should never win over `node`.
	'browser',
] as const

export function buildPluxelResolveConditions(env = process.env.NODE_ENV): string[] {
	const extras = env && !DEFAULT_NODE_RESOLVE_CONDITIONS.includes(env as any) ? [env] : []
	return uniqStrings([
		...PLUXEL_BASE_RESOLVE_CONDITIONS,
		...DEFAULT_NODE_RESOLVE_CONDITIONS,
		...extras,
	])
}

function toArray(value: string | string[] | undefined): string[] | undefined {
	if (value === undefined) return undefined
	return Array.isArray(value) ? value : [value]
}

function asPluginArray(value: UserConfig['plugins']): NonNullable<UserConfig['plugins']> {
	if (!value) return []
	return Array.isArray(value) ? value : [value]
}

function uniqStrings(values: string[]): string[] {
	return Array.from(new Set(values))
}

function asStringArray(value: unknown): string[] {
	if (!value) return []
	if (Array.isArray(value)) return value.filter((x): x is string => typeof x === 'string')
	return typeof value === 'string' ? [value] : []
}

function normalizeGlob(pattern: string): string {
	if (pattern.startsWith('**/') || pattern.startsWith('/') || pattern.startsWith('!')) return pattern
	return `**/${pattern}`
}

function normalizeGlobs(patterns: string[]): string[] {
	return patterns.map((p) => normalizeGlob(p))
}

/**
 * Opinionated Vitest preset for Pluxel monorepo tests:
 * - enables `@pluxel/source` + `@pluxel/hmr` resolution conditions
 * - installs configSource + importTypeFixer Vite plugins (compile-time metadata extraction)
 * - runs `@pluxel/test/setup` once per worker
 */
export function definePluxelVitestConfig(
	overrides: UserConfigExport = {},
	options: PluxelVitestOptions = {},
): UserConfigExport {
	const include = normalizeGlobs(
		toArray(options.include) ?? ['packages/**/src/**/*.ts', 'packages/**/tests/**/*.ts'],
	)
	const exclude = normalizeGlobs(toArray(options.exclude) ?? ['**/node_modules/**', '**/*.d.ts'])
	const baseConditions = buildPluxelResolveConditions()

	const base: UserConfig = {
		resolve: { conditions: baseConditions },
		ssr: { resolve: { conditions: baseConditions } },
		test: {
			environment: 'node',
			setupFiles: ['@pluxel/test/setup'],
			// Avoid Vite deps optimizer OOMs in large monorepos (node tests don't need it).
			deps: {
				optimizer: {
					ssr: { enabled: false },
					web: { enabled: false },
				},
			},
		},
	}

	const toolchainPlugins: NonNullable<UserConfig['plugins']> = [
		...asPluginArray(options.prePlugins),
		importTypeFixerPlugin({ include, exclude }),
		configSourcePlugin({ include, exclude }),
	]

	const finalize = (resolved: UserConfig): UserConfig => {
		const overridePlugins = asPluginArray(resolved.plugins)
		const { plugins: _ignored, ...rest } = resolved
		const merged = mergeConfig(base, rest as UserConfig) as UserConfig

		// Always keep Pluxel resolution conditions available (and allow caller to add more).
		const mergedConditions = uniqStrings([
			...baseConditions,
			...asStringArray(merged.resolve?.conditions),
		])
		merged.resolve = { ...(merged.resolve ?? {}), conditions: mergedConditions }
		merged.ssr = merged.ssr ?? {}
		merged.ssr.resolve = {
			...(merged.ssr.resolve ?? {}),
			conditions: uniqStrings([
				...baseConditions,
				...asStringArray(merged.ssr.resolve?.conditions),
			]),
		}

		// Always keep core setup in place. Caller can add more setup files.
		merged.test = merged.test ?? {}
		merged.test.setupFiles = uniqStrings([
			'@pluxel/test/setup',
			...asStringArray(merged.test.setupFiles),
		])

		// Compose plugins with explicit order control.
		merged.plugins = [...toolchainPlugins, ...overridePlugins]

		return merged
	}

	if (typeof overrides === 'function') {
		return defineConfig(async (env) => {
			const resolved = (await overrides(env as any)) as UserConfig
			return finalize(resolved ?? {})
		})
	}

	return defineConfig(
		(async () => {
			const resolved = (await overrides) as UserConfig
			return finalize(resolved ?? {})
		})(),
	)
}

export default definePluxelVitestConfig()

type WorkspacePackage = { name: string; dir: string }
type WorkspaceDirent = { name: string; isDirectory: () => boolean; isFile: () => boolean }

export type PluxelVitestWorkspaceOptions = {
	/**
	 * Workspace directories to scan for packages (defaults to common Pluxel layouts).
	 * Each directory is relative to `process.cwd()`.
	 */
	roots?: readonly string[]
	/** Per-project Vitest test config overrides. */
	projectTest?: Omit<NonNullable<UserConfig['test']>, 'name' | 'include' | 'exclude' | 'setupFiles'>
	/** Top-level Vitest test config (e.g. worker limits). */
	test?: Omit<NonNullable<UserConfig['test']>, 'projects'>
	/** Test file include globs (relative to each package root). */
	includeTests?: readonly string[]
	/** Test file exclude globs (relative to each package root). */
	excludeTests?: readonly string[]
	/** Include patterns for toolchain extraction (relative to each package root). */
	includeToolchain?: readonly string[]
	/** Exclude patterns for toolchain extraction (relative to each package root). */
	excludeToolchain?: readonly string[]
	/** Optional filter to include/exclude workspace packages. */
	filter?: (pkg: WorkspacePackage) => boolean
}

function tryReadWorkspacePkgInfo(dir: string): WorkspacePackage | null {
	try {
		const json = readFileSync(join(dir, 'package.json'), 'utf-8')
		const pkg = JSON.parse(json) as { name?: unknown }
		if (typeof pkg.name !== 'string') return null
		return { name: pkg.name, dir }
	} catch {
		return null
	}
}

function hasTestFiles(dir: string): boolean {
	try {
		const entries = readdirSync(dir, { withFileTypes: true }) as unknown as WorkspaceDirent[]
		for (const e of entries) {
			if (!e.isDirectory() && !e.isFile()) continue
			if (e.isFile() && (e.name.endsWith('.test.ts') || e.name.endsWith('.spec.ts'))) return true
			if (e.isDirectory()) {
				if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue
				if (e.name === 'tests') return true
				if (hasTestFiles(join(dir, e.name))) return true
			}
		}
		return false
	} catch {
		return false
	}
}

function collectWorkspacePackages(roots: readonly string[]): WorkspacePackage[] {
	const root = process.cwd()
	const out: WorkspacePackage[] = []

	for (const r of roots) {
		const base = join(root, r)
		let entries: WorkspaceDirent[]
		try {
			entries = readdirSync(base, { withFileTypes: true }) as unknown as WorkspaceDirent[]
		} catch {
			continue
		}
		for (const entry of entries) {
			if (!entry.isDirectory()) continue
			const dir = join(base, entry.name)
			const info = tryReadWorkspacePkgInfo(dir)
			if (info && hasTestFiles(dir)) out.push(info)
		}
	}

	return out
}

export function collectPluxelVitestWorkspaceProjects(
	options: Pick<PluxelVitestWorkspaceOptions, 'roots' | 'filter'> = {},
): WorkspacePackage[] {
	const roots =
		options.roots ?? (['packages', 'plugins', 'builtin-plugins', 'render-plugins', 'chatbots'] as const)
	return collectWorkspacePackages(roots).filter((p) => options.filter?.(p) ?? true)
}

/**
 * Convenience helper for monorepos:
 * - discovers workspace packages with test files
 * - builds one Vitest project per package
 * - applies Pluxel toolchain transforms so plugin metadata extraction works in tests
 */
export function definePluxelVitestWorkspaceConfig(
	options: PluxelVitestWorkspaceOptions = {},
): UserConfigExport {
	const includeTests = options.includeTests ?? (['**/*.test.ts', '**/*.spec.ts'] as const)
	const excludeTests = options.excludeTests ?? (['**/node_modules/**', '**/dist/**', '**/.*/**'] as const)

	const includeToolchain =
		options.includeToolchain ??
		([
			'src/**/*.ts',
			'src/**/*.tsx',
			'tests/**/*.ts',
			'tests/**/*.tsx',
			'fsm/**/*.ts',
			'fsm/**/*.tsx',
			'parts/**/*.ts',
			'parts/**/*.tsx',
		] as const)
	const excludeToolchain =
		options.excludeToolchain ?? (['node_modules/**', 'dist/**', '**/*.d.ts', '.*/**'] as const)

	const pkgs = collectPluxelVitestWorkspaceProjects(options)
	const projects = pkgs.map((p) => {
		return definePluxelVitestConfig(
			{
				root: p.dir,
				test: {
					name: p.name,
					include: [...includeTests],
					exclude: [...excludeTests],
					...(options.projectTest ?? {}),
				},
			},
			{ include: [...includeToolchain], exclude: [...excludeToolchain] },
		)
	})

	return defineConfig({
		test: {
			...(options.test ?? {}),
			projects,
		},
	})
}
