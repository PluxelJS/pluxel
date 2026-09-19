import type { Context } from '@pluxel/core'
import { installOwnerViewCapability } from '@pluxel/core/host'
import { defineHostService } from '@pluxel/host'
import { Commands } from './commands/token'
import { CommandsService } from './commands/service'

export { Commands } from './commands/token'
export type { CommandsService, CommandCatalogSnapshot, CommandMount } from './commands/service'

/** Install an empty root command catalog with generation-owned registrations and carrier mounts. */
export function commands() {
	return defineHostService({
		name: 'Commands',
		capabilities: [
			installOwnerViewCapability(Commands, {
				property: 'commands',
				createRoot: (root) => new CommandsService(root as Context),
				createView: (rootService, owner) =>
					owner === owner.root ? rootService : new CommandsService(owner as Context, rootService),
			}),
		],
	})
}
