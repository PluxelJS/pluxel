import { http } from './http'
import { commands } from './commands'
import { nodeModules } from './node'
import { workers } from './workers'
import { persistence, type PersistenceServiceConfig } from './persistence'

/** The default server service list is explicit and fixed; optional Database, Vault, Logging and Management are composed separately. */
export function standardServices(options: Readonly<{ persistence: PersistenceServiceConfig }>) {
	return [http(), commands(), nodeModules(), workers(), persistence(options.persistence)] as const
}
