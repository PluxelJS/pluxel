import type { HostService } from '@pluxel/host'

import { http } from './http'
import { commands } from './commands'
import { nodeModules, type NodeModuleArtifactHostOptions } from './node'
import { workers } from './workers'
import { persistence, type PersistenceServiceConfig } from './persistence'

/** The default server service list is explicit and fixed; optional Database, Vault, logging backends and Management are composed separately. */
export function standardServices(
	options: Readonly<{
		persistence: PersistenceServiceConfig
		/** Production artifact location; development attaches its compiler separately. */
		nodeModules?: NodeModuleArtifactHostOptions
	}>,
): readonly HostService[] {
	return [
		http(),
		commands(),
		nodeModules(options.nodeModules),
		workers(),
		persistence(options.persistence),
	] as const
}
