import { isAbsolute, resolve } from 'pathe'
import type { PluxelHmrConfigV1 } from './config'
import { DEFAULT_HMR_CONFIG_BASENAME, readHmrConfigV1 } from './config'
import type { WorkspaceSnapshot } from './diagnose'
import { diagnoseWorkspace, mergeHmrProfile } from './diagnose'
import { uniqPreserveOrder } from './utils'

export type HmrProfileRef = {
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
	 * - Defaults to `${rootDir}/${DEFAULT_HMR_CONFIG_BASENAME}`
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
}

export type HmrProfileView = {
	rootDir: string
	configPath: string
	config: PluxelHmrConfigV1
	activeProfile: string
	roots: 'auto' | string[]
	enabled: string[]
	builtinPackages: string[]
	includeGlobs: string[]
	excludeGlobs: string[]
}

export function resolveHmrConfigPath(ref: Pick<HmrProfileRef, 'rootDir' | 'configPath'> = {}) {
	const rootDirAbs = resolve(ref.rootDir ?? process.cwd())
	const raw = ref.configPath?.trim()
	if (!raw) return resolve(rootDirAbs, DEFAULT_HMR_CONFIG_BASENAME)
	return isAbsolute(raw) ? raw : resolve(rootDirAbs, raw)
}

export function readHmrConfig(ref: Pick<HmrProfileRef, 'rootDir' | 'configPath'> = {}) {
	const rootDirAbs = resolve(ref.rootDir ?? process.cwd())
	const configPathAbs = resolveHmrConfigPath({ rootDir: rootDirAbs, configPath: ref.configPath })
	const config = readHmrConfigV1(configPathAbs)
	return { rootDir: rootDirAbs, configPath: configPathAbs, config }
}

/**
 * Read `pluxel.hmr.jsonc` and return the effective (merged) profile view.
 *
 * This is intentionally lightweight (config-only): no workspace scanning, no plugin discovery.
 */
export function readHmrProfileView(ref: HmrProfileRef = {}): HmrProfileView {
	const { rootDir, configPath, config } = readHmrConfig(ref)
	const env = { ...(ref.env ?? process.env) }
	if (ref.profile) env.PLUXEL_HMR_PROFILE = ref.profile
	const merged = mergeHmrProfile(config, env)

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

export function getHmrProfileBuiltinPackages(ref: HmrProfileRef = {}): string[] {
	return readHmrProfileView(ref).builtinPackages
}

export function getHmrProfileEnabledPackages(ref: HmrProfileRef = {}): string[] {
	return readHmrProfileView(ref).enabled
}

export type ResolveHmrWorkspaceSnapshotOptions = HmrProfileRef & {
	/**
	 * Package names to omit from discovery/enabled resolution.
	 *
	 * Primary use case: hosts that preload certain packages as builtins and want to avoid
	 * double-loading their `@pluxel/runtime` source entries.
	 */
	omitPackages?: string[]
}

/**
 * Diagnose the workspace using `pluxel.hmr.jsonc` and return a full `WorkspaceSnapshot`.
 *
 * Convenience wrapper around {@link diagnoseWorkspace} that throws on failure.
 */
export async function resolveHmrWorkspaceSnapshot(
	ref: ResolveHmrWorkspaceSnapshotOptions,
): Promise<WorkspaceSnapshot> {
	const rootDirAbs = resolve(ref.rootDir ?? process.cwd())
	const configPathAbs = resolveHmrConfigPath({ rootDir: rootDirAbs, configPath: ref.configPath })
	const env = { ...(ref.env ?? process.env) }
	if (ref.profile) env.PLUXEL_HMR_PROFILE = ref.profile

	const res = await diagnoseWorkspace({
		rootDir: rootDirAbs,
		configPath: configPathAbs,
		env,
		omitPackages: ref.omitPackages,
	})
	if (res.ok === false) throw new Error(res.errors.join('\n'))
	return res.snapshot
}
