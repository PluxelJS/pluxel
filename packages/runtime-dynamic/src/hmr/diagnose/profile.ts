import { isAbsolute, resolve } from 'pathe'
import { DEFAULT_LOADER_HMR_CONFIG_BASENAME, readLoaderHmrConfigV1, type PluxelLoaderHmrConfigV1 } from './config'
import { diagnoseWorkspace, mergeLoaderHmrProfile, type WorkspaceSnapshot } from './diagnose'
import { nodeLoaderHmrWorkspaceFs, type LoaderHmrWorkspaceFs } from './fs'
import { uniqPreserveOrder } from './utils'

export type LoaderHmrProfileRef = {
	/**
	 * Workspace root directory.
	 *
	 * Defaults to `process.cwd()`.
	 */
	rootDir?: string
	/**
	 * Workspace profiles config file path.
	 *
	 * - When absolute: used as-is
	 * - When relative: resolved from `rootDir`
	 * - Defaults to `${rootDir}/${DEFAULT_LOADER_HMR_CONFIG_BASENAME}`
	 */
	configPath?: string
	/**
	 * Profile override for this load.
	 *
	 * Equivalent to setting `PLUXEL_HMR_PROFILE`.
	 */
	profile?: string
	/**
	 * Environment used for profile selection (optional).
	 *
	 * Defaults to `process.env`. When `profile` is provided, it wins over `env.PLUXEL_HMR_PROFILE`.
	 */
	env?: Record<string, string | undefined>
	fs?: LoaderHmrWorkspaceFs
}

export type LoaderHmrProfileView = {
	rootDir: string
	configPath: string
	config: PluxelLoaderHmrConfigV1
	activeProfile: string
	roots: 'auto' | string[]
	enabled: string[]
	builtinPackages: string[]
	includeGlobs: string[]
	excludeGlobs: string[]
}

export function resolveLoaderHmrConfigPath(ref: Pick<LoaderHmrProfileRef, 'rootDir' | 'configPath'> = {}) {
	const rootDirAbs = resolve(ref.rootDir ?? process.cwd())
	const raw = ref.configPath?.trim()
	if (!raw) return resolve(rootDirAbs, DEFAULT_LOADER_HMR_CONFIG_BASENAME)
	return isAbsolute(raw) ? raw : resolve(rootDirAbs, raw)
}

export function readLoaderHmrConfigRaw(ref: Pick<LoaderHmrProfileRef, 'rootDir' | 'configPath' | 'fs'> = {}) {
	const rootDirAbs = resolve(ref.rootDir ?? process.cwd())
	const configPathAbs = resolveLoaderHmrConfigPath({ rootDir: rootDirAbs, configPath: ref.configPath })
	const config = readLoaderHmrConfigV1(configPathAbs, ref.fs ?? nodeLoaderHmrWorkspaceFs)
	return { rootDir: rootDirAbs, configPath: configPathAbs, config }
}

/**
 * Read `pluxel.loader.hmr.jsonc` and return the effective (merged) profile view.
 *
 * This is intentionally lightweight (config-only): no workspace scanning, no plugin discovery.
 */
export function readLoaderHmrProfileView(ref: LoaderHmrProfileRef = {}): LoaderHmrProfileView {
	const { rootDir, configPath, config } = readLoaderHmrConfigRaw(ref)
	const env = { ...(ref.env ?? process.env) }
	if (ref.profile) env.PLUXEL_HMR_PROFILE = ref.profile
	const merged = mergeLoaderHmrProfile(config, env)

	return {
		rootDir,
		configPath,
		config,
		activeProfile: merged.activeProfile,
		roots: merged.roots,
		enabled: uniqPreserveOrder(merged.enabled),
		builtinPackages: uniqPreserveOrder(merged.builtinPackages),
		includeGlobs: uniqPreserveOrder(merged.includeGlobs),
		excludeGlobs: uniqPreserveOrder(merged.excludeGlobs),
	}
}

export function getLoaderHmrProfileBuiltinPackages(ref: LoaderHmrProfileRef = {}): string[] {
	return readLoaderHmrProfileView(ref).builtinPackages
}

export function getLoaderHmrProfileEnabledPackages(ref: LoaderHmrProfileRef = {}): string[] {
	return readLoaderHmrProfileView(ref).enabled
}

export type ResolveLoaderHmrWorkspaceOptions = LoaderHmrProfileRef & {
	/**
	 * Package names to omit from discovery/enabled resolution.
	 *
	 * Primary use case: hosts that preload certain packages as builtins and want to avoid
	 * double-loading their `@pluxel/runtime-dynamic` source entries.
	 */
	omitPackages?: string[]
}

/**
 * Diagnose the workspace using `pluxel.loader.hmr.jsonc` and return a full `WorkspaceSnapshot`.
 *
 * Convenience wrapper around {@link diagnoseWorkspace} that throws on failure.
 */
export async function resolveLoaderHmrWorkspace(
	ref: ResolveLoaderHmrWorkspaceOptions,
): Promise<WorkspaceSnapshot> {
	const rootDirAbs = resolve(ref.rootDir ?? process.cwd())
	const configPathAbs = resolveLoaderHmrConfigPath({ rootDir: rootDirAbs, configPath: ref.configPath })
	const env = { ...(ref.env ?? process.env) }
	if (ref.profile) env.PLUXEL_HMR_PROFILE = ref.profile

	const res = await diagnoseWorkspace({
		rootDir: rootDirAbs,
		configPath: configPathAbs,
		env,
		omitPackages: ref.omitPackages,
		fs: ref.fs,
	})
	if (res.ok === false) throw new Error(res.errors.join('\n'))
	return res.snapshot
}
