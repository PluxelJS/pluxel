import { http } from './http'
import { commands } from './commands'
import { nodeModules, type NodeModuleArtifactHostOptions } from './node'
import { workers } from './workers'
import { persistence, type PersistenceServiceConfig } from './persistence'

/** The default server service list is explicit and fixed; optional Database, Vault, Logging and Management are composed separately. */
export function standardServices(
	options: Readonly<{
		persistence: PersistenceServiceConfig
		/** Production artifact location; development attaches its compiler separately. */
		nodeModules?: NodeModuleArtifactHostOptions
	}>,
) {
	return [
		http(),
		commands(),
		nodeModules(options.nodeModules),
		workers(),
		persistence(options.persistence),
	] as const
}
