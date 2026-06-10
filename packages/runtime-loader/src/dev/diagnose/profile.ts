import { isAbsolute, resolve } from 'pathe'
import { DEFAULT_LOADER_DEV_CONFIG_BASENAME, readLoaderDevConfigV1, type PluxelLoaderDevConfigV1 } from './config'
import { diagnoseWorkspace, mergeLoaderDevProfile, type WorkspaceSnapshot } from './diagnose'
import { nodeLoaderDevWorkspaceFs, type LoaderDevWorkspaceFs } from './fs'
import { uniqPreserveOrder } from './utils'

export type LoaderDevProfileRef = {
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
	 * - Defaults to `${rootDir}/${DEFAULT_LOADER_DEV_CONFIG_BASENAME}`
	 */
	configPath?: string
	/**
	 * Profile override for this load.
	 *
	 * Equivalent to setting `PLUXEL_DEV_PROFILE`.
	 */
	profile?: string
	/**
	 * Environment used for profile selection (optional).
	 *
	 * Defaults to `process.env`. When `profile` is provided, it wins over `env.PLUXEL_DEV_PROFILE`.
	 */
	env?: Record<string, string | undefined>
	fs?: LoaderDevWorkspaceFs
}

export type LoaderDevProfileView = {
	rootDir: string
	configPath: string
	config: PluxelLoaderDevConfigV1
	activeProfile: string
	roots: 'auto' | string[]
	enabled: string[]
	builtinPackages: string[]
	includeGlobs: string[]
	excludeGlobs: string[]
}

export function resolveLoaderDevConfigPath(ref: Pick<LoaderDevProfileRef, 'rootDir' | 'configPath'> = {}) {
	const rootDirAbs = resolve(ref.rootDir ?? process.cwd())
	const raw = ref.configPath?.trim()
	if (!raw) return resolve(rootDirAbs, DEFAULT_LOADER_DEV_CONFIG_BASENAME)
	return isAbsolute(raw) ? raw : resolve(rootDirAbs, raw)
}

export function readLoaderDevConfigRaw(ref: Pick<LoaderDevProfileRef, 'rootDir' | 'configPath' | 'fs'> = {}) {
	const rootDirAbs = resolve(ref.rootDir ?? process.cwd())
	const configPathAbs = resolveLoaderDevConfigPath({ rootDir: rootDirAbs, configPath: ref.configPath })
	const config = readLoaderDevConfigV1(configPathAbs, ref.fs ?? nodeLoaderDevWorkspaceFs)
	return { rootDir: rootDirAbs, configPath: configPathAbs, config }
}

/**
 * Read `pluxel.loader.dev.jsonc` and return the effective (merged) profile view.
 *
 * This is intentionally lightweight (config-only): no workspace scanning, no plugin discovery.
 */
export function readLoaderDevProfileView(ref: LoaderDevProfileRef = {}): LoaderDevProfileView {
	const { rootDir, configPath, config } = readLoaderDevConfigRaw(ref)
	const env = { ...(ref.env ?? process.env) }
	if (ref.profile) env.PLUXEL_DEV_PROFILE = ref.profile
	const merged = mergeLoaderDevProfile(config, env)

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

export function getLoaderDevProfileBuiltinPackages(ref: LoaderDevProfileRef = {}): string[] {
	return readLoaderDevProfileView(ref).builtinPackages
}

export function getLoaderDevProfileEnabledPackages(ref: LoaderDevProfileRef = {}): string[] {
	return readLoaderDevProfileView(ref).enabled
}

export type ResolveLoaderDevWorkspaceOptions = LoaderDevProfileRef & {
	/**
	 * Package names to omit from discovery/enabled resolution.
	 *
	 * Primary use case: hosts that preload certain packages as builtins and want to avoid
	 * double-loading their `@pluxel/runtime-loader` source entries.
	 */
	omitPackages?: string[]
}

/**
 * Diagnose the workspace using `pluxel.loader.dev.jsonc` and return a full `WorkspaceSnapshot`.
 *
 * Convenience wrapper around {@link diagnoseWorkspace} that throws on failure.
 */
export async function resolveLoaderDevWorkspace(
	ref: ResolveLoaderDevWorkspaceOptions,
): Promise<WorkspaceSnapshot> {
	const rootDirAbs = resolve(ref.rootDir ?? process.cwd())
	const configPathAbs = resolveLoaderDevConfigPath({ rootDir: rootDirAbs, configPath: ref.configPath })
	const env = { ...(ref.env ?? process.env) }
	if (ref.profile) env.PLUXEL_DEV_PROFILE = ref.profile

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
