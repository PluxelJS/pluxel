import type { HostService } from '@pluxel/host'

import { elysia } from './elysia'
import { commands } from './commands'
import { nodeModules, type NodeModuleArtifactHostOptions } from './node'
import { workers } from './workers'
import { fs, type FsServiceConfig } from './fs'
import { tinybase } from './tinybase'

/** Fixed server services; Vault, logging backends and Management are composed separately. */
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
		tinybase(),
	] as const
}
