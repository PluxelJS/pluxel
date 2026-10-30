import type { HostService } from '@pluxel/host'

import { elysia } from './elysia'
import { commands } from './commands'
import { nodeModules, type NodeModuleArtifactHostOptions } from './node'
import { workers } from './workers'
import { fs, type FsServiceConfig } from './fs'

/** The default server service list is explicit and fixed; optional Database, Vault, logging backends and Management are composed separately. */
export function standardServices(
	options: Readonly<{
		fs: FsServiceConfig
		/** Production artifact location; development attaches its compiler separately. */
		nodeModules?: NodeModuleArtifactHostOptions
	}>,
): readonly HostService[] {
	return [
		elysia(),
		commands(),
		nodeModules(options.nodeModules),
		workers(),
		fs(options.fs),
	] as const
}
