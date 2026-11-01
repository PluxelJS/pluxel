import type { ConfigMounts } from '@zenfs/core'
import { snapshotFsConfig, type FsConfig, type ResolvedFsConfig } from '../fs/config'

/**
 * Validate and freeze a native storage declaration without preparing its backends.
 * Mount points are normalized and an omitted root uses InMemory. Backend,
 * FileSystem and opaque backend option identities remain unchanged; readiness and
 * backend-specific option checks still happen when Core prepares the filesystem.
 */
export function zenfs<TMounts extends ConfigMounts = ConfigMounts>(
	config: FsConfig<TMounts> = {},
): ResolvedFsConfig {
	return snapshotFsConfig(config)
}
