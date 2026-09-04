import { resolve } from 'node:path'
import {
	configSourcePlugin,
	createPluginSemanticsPlugin,
	lintGuardPlugin,
} from '@pluxel/rolldown/plugins'
import { databaseSourceVitePlugin } from '@pluxel/rolldown/vite'
import { mergeConfig, type ViteUserConfig } from 'vitest/config'

/**
 * Preset settings that control Pluxel's source toolchain rather than Vitest test discovery.
 *
 * They are supplied under `definePluxelVitestConfig({ pluxel: … })` and are consumed before
 * the resulting config reaches Vite/Vitest.
 */
export type PluxelVitestToolchainConfig = Readonly<{
	/** Include patterns for Pluxel semantic lowering and config extraction (default: src/tests). */
	include?: string | readonly string[]
	/** Exclude patterns for Pluxel semantic lowering and config extraction. */
	exclude?: string | readonly string[]
	/**
	 * Extra Vite plugins to run BEFORE Pluxel toolchain plugins.
	 *
	 * Useful when your test suite needs an additional transform that should apply to source
	 * before `configSourcePlugin` runs.
	 */
	prePlugins?: NonNullable<ViteUserConfig['plugins']>
}>

/**
 * One Vitest/Vite config object with an explicit Pluxel-owned namespace.
 *
 * `test` and every other Vite field retain native Vite/Vitest semantics. `pluxel` only controls
 * the preset's source toolchain and is removed before Vite receives the resolved config.
 */
export type PluxelVitestConfig = ViteUserConfig & {
	pluxel?: PluxelVitestToolchainConfig
}

const PLUXEL_BASE_RESOLVE_CONDITIONS = ['@pluxel/hmr', 'development', '@pluxel/source'] as const

const DEFAULT_NODE_RESOLVE_CONDITIONS = [
	// Prefer Node-friendly exports in tests.
	'node',
	// `import` is a Node contract; `module` is only a bundler convention and may
	// point at ESM that Node cannot execute without extension rewriting.
	'import',
	'production',
	'default',
] as const

// Externalized dependencies are executed directly by Node. Keep bundler-only
// conditions such as `module` and `browser` out of this set: packages may map
// them to ESM that intentionally relies on extension rewriting or bundling.
const DEFAULT_NODE_EXTERNAL_RESOLVE_CONDITIONS = ['node', 'import', 'default'] as const

// `*.typecheck.*` files are compile-only API probes. They intentionally use declarations that
// are not executable Plugin source and therefore must stay out of the Vite source transforms.
// TypeScript still includes them through the package tsconfig.
const COMPILE_ONLY_TYPECHECK_EXCLUDES = [
	'**/*.typecheck.ts',
	'**/*.typecheck.tsx',
	'**/*.typecheck.mts',
	'**/*.typecheck.cts',
] as const

function buildPluxelResolveConditions(env = process.env.NODE_ENV): string[] {
	const extras = env && !DEFAULT_NODE_RESOLVE_CONDITIONS.includes(env as any) ? [env] : []
	return uniqStrings([
		...PLUXEL_BASE_RESOLVE_CONDITIONS,
		...DEFAULT_NODE_RESOLVE_CONDITIONS,
		...extras,
	])
}

function toArray(value: string | readonly string[] | undefined): string[] | undefined {
	if (value === undefined) return undefined
	return typeof value === 'string' ? [value] : [...value]
}

function asPluginArray(value: ViteUserConfig['plugins']): NonNullable<ViteUserConfig['plugins']> {
	if (!value) return []
	return Array.isArray(value) ? value : [value]
}

function uniqStrings(values: string[]): string[] {
	return Array.from(new Set(values))
}

function normalizeGlob(pattern: string): string {
	if (pattern.startsWith('**/') || pattern.startsWith('/') || pattern.startsWith('!'))
		return pattern
	return `**/${pattern}`
}

function normalizeGlobs(patterns: string[]): string[] {
	return uniqStrings(
		patterns.flatMap((pattern) => {
			const normalized = normalizeGlob(pattern)
			// Vite's hook-filter glob matcher treats the final `**/` as one-or-more
			// directories. Add the zero-depth form so `src/index.ts` is transformed too.
			const direct = normalized.replace(/\/\*\*\/([^/]+)$/, '/$1')
			return direct === normalized ? [normalized] : [normalized, direct]
		}),
	)
}

/**
 * Opinionated Vitest preset for Pluxel monorepo tests:
 * - resolves plugin, neutral-development, then framework-source entries in that order
 * - installs lint guard + configSource Vite plugins (source-policy enforcement + metadata extraction)
 */
export function definePluxelVitestConfig(config: PluxelVitestConfig = {}): ViteUserConfig {
	const { pluxel = {}, ...overrides } = config
	const include = normalizeGlobs(
		toArray(pluxel.include) ?? ['src/**/*.ts', 'src/**/*.tsx', 'tests/**/*.ts', 'tests/**/*.tsx'],
	)
	const exclude = normalizeGlobs([
		...(toArray(pluxel.exclude) ?? ['**/node_modules/**', '**/*.d.ts']),
		...COMPILE_ONLY_TYPECHECK_EXCLUDES,
	])
	const baseConditions = buildPluxelResolveConditions()

	const base: ViteUserConfig = {
		resolve: {
			conditions: baseConditions,
			externalConditions: [...DEFAULT_NODE_EXTERNAL_RESOLVE_CONDITIONS],
		},
		ssr: {
			resolve: {
				conditions: baseConditions,
				externalConditions: [...DEFAULT_NODE_EXTERNAL_RESOLVE_CONDITIONS],
			},
			// Generated metadata imports must share the same source-mode runtime instance as tests.
			noExternal: ['@pluxel/runtime'],
		},
		test: {
			environment: 'node',
			// Monorepos commonly have packages without tests. Keep local runs friendly,
			// but still allow CI to fail if a project unexpectedly has no tests.
			passWithNoTests: !process.env.CI,
			server: {
				deps: { inline: ['@pluxel/runtime'] },
			},
		},
	}

	const finalize = (resolved: ViteUserConfig): ViteUserConfig => {
		const overridePlugins = asPluginArray(resolved.plugins)
		const { plugins: _ignored, ...rest } = resolved
		const merged = mergeConfig(base, rest as ViteUserConfig) as ViteUserConfig
		const projectRoot = resolve(merged.root ?? process.cwd())
		const toolchainPlugins: NonNullable<ViteUserConfig['plugins']> = [
			...asPluginArray(pluxel.prePlugins),
			databaseSourceVitePlugin({ root: projectRoot }),
			createPluginSemanticsPlugin({ root: projectRoot, include, exclude }).plugin,
			lintGuardPlugin({ cwd: projectRoot }),
			configSourcePlugin({ include, exclude }),
		]

		// Keep Pluxel resolution deterministic: internal packages use @pluxel/source,
		// plugin packages use @pluxel/hmr. Do not let per-package config widen this.
		merged.resolve = {
			...merged.resolve,
			conditions: baseConditions,
			externalConditions: [...DEFAULT_NODE_EXTERNAL_RESOLVE_CONDITIONS],
		}
		merged.ssr = merged.ssr ?? {}
		merged.ssr.resolve = {
			...merged.ssr.resolve,
			conditions: baseConditions,
			externalConditions: [...DEFAULT_NODE_EXTERNAL_RESOLVE_CONDITIONS],
		}

		// Compose plugins with explicit order control.
		merged.plugins = [...toolchainPlugins, ...overridePlugins]

		return merged
	}

	return finalize(overrides)
}

export default definePluxelVitestConfig()
