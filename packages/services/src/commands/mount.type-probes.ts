import type {
	CommandContext,
	CommandRegistration,
	DirectCommand,
	Registration,
} from '@pluxel/commands'
import type { CommandsService } from './service'
import type { CommandMount } from './mount'

interface CarrierContext extends CommandContext {
	readonly reply: (content: string) => Promise<void>
}

declare const mount: CommandMount<CarrierContext>
declare const commands: CommandsService
declare const portable: DirectCommand<{ id: string }, { value: string }, CommandContext>
declare const carrierNative: DirectCommand<{ id: string }, { value: string }, CarrierContext>
declare const installed: CommandRegistration<{ id: string }, { value: string }, CarrierContext>
declare const registration: Registration

mount.bind(portable, () => registration)
mount.bind(carrierNative, (owned) => {
	void owned.execute({ id: 'probe' }, { reply: async () => {} })
	return registration
})
commands.register(portable)

// @ts-expect-error A registration is not a direct command definition.
mount.bind(installed, () => registration)
// @ts-expect-error Root CommandsService cannot construct carrier-only context fields.
commands.register(carrierNative)
