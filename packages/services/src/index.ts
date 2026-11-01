import type { HostService } from '@pluxel/host'

import { elysia } from './elysia'
import { commands } from './commands'
import { nodeModules, type NodeModuleArtifactHostOptions } from './node'
import { workers } from './workers'

/** Fixed server services; Vault and Management are composed separately. */
export function standardServices(
	options: Readonly<{
		/** Production artifact location; development attaches its compiler separately. */
		nodeModules?: NodeModuleArtifactHostOptions
	}> = {},
): readonly HostService[] {
	return [elysia(), commands(), nodeModules(options.nodeModules), workers()] as const
}
