import type {
	CommandContext,
	CommandRegistration,
	DirectCommand,
	InstalledCommand,
	Registration,
} from '@pluxel/commands'
import type { CommandsService } from '../CommandsService'
import type { CommandMount } from './CommandMount'

interface CarrierContext extends CommandContext {
	readonly reply: (content: string) => Promise<void>
}

declare const mount: CommandMount<CarrierContext>
declare const commands: CommandsService
declare const portable: DirectCommand<{ id: string }, { value: string }, CommandContext>
declare const carrierNative: DirectCommand<{ id: string }, { value: string }, CarrierContext>
declare const installed: CommandRegistration<{ id: string }, { value: string }, CarrierContext>
declare const widenedInstalled: InstalledCommand<{ id: string }, { value: string }, CarrierContext>
declare const registration: Registration

mount.bind(portable, () => registration)
mount.bind(carrierNative, (owned) => {
	void owned.execute({ id: 'probe' }, { reply: async () => {} })
	return registration
})
commands.register(portable)

// @ts-expect-error Installed handles follow compatible catalog replacement.
mount.bind(installed, () => registration)
// @ts-expect-error Widening away dispose does not erase InstalledCommand identity.
mount.bind(widenedInstalled, () => registration)
// @ts-expect-error Root CommandsService cannot construct carrier-only context fields.
commands.register(carrierNative)
