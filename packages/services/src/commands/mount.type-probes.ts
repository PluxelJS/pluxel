import {
	Result,
	snapshotCommand,
	type CommandContext,
	type CommandRegistration,
	type DirectCommand,
	type Registration,
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

mount.bind(portable, { install: () => registration })
mount.bind(carrierNative, {
	install: (owned) => {
		void owned.execute({ id: 'probe' }, { reply: async () => {} })
		return registration
	},
})
commands.register(portable)

// @ts-expect-error A registration is not a direct command definition.
mount.bind(installed, { install: () => registration })
// @ts-expect-error Root CommandsService cannot construct carrier-only context fields.
commands.register(carrierNative)

interface ActorContext extends CommandContext {
	readonly actorId: string
}
declare const actorCommand: DirectCommand<{ id: string }, { value: string }, ActorContext>

// @ts-expect-error Direct publication cannot invent the command's trusted actor context.
mount.bind(actorCommand, { install: () => registration })
mount.bind(actorCommand, {
	async handle(command, candidate, context) {
		const result = await command.execute(candidate as { id: string }, {
			actorId: 'trusted-actor',
			signal: context.signal,
		})
		if (result.isErr()) return Result.err(result.error)
		await context.reply(result.value.value)
		return result.map(() => 'rendered')
	},
	install(endpoint) {
		void endpoint
			.execute({ id: 'probe' }, { reply: async () => {} })
			.then((result) => (result.isOk() ? result.value.toUpperCase() : undefined))
		// @ts-expect-error A publication snapshot cannot become a direct definition.
		mount.bind(snapshotCommand(endpoint), { install: () => registration })
		// @ts-expect-error A mounted endpoint is not another direct definition.
		mount.bind(endpoint, { install: () => registration })
		return registration
	},
})

mount.bind(snapshotCommand(portable), { install: () => registration })
// @ts-expect-error A registry publication snapshot retains its lifetime restriction.
mount.bind(snapshotCommand(installed), { install: () => registration })
