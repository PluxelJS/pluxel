import { defineContextCapability, type ContextCapability } from '@pluxel/core/host'
import type { CommandsService } from './service'

export const Commands: ContextCapability<CommandsService> =
	defineContextCapability<CommandsService>('services.commands', {
		access: 'all',
		property: 'commands',
	})

declare module '@pluxel/core' {
	interface ContextServices {
		readonly commands: CommandsService
	}
}
