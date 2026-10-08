import { BasePlugin, Plugin } from '@pluxel/core'
import { Result, type Command, type CommandContext } from '@pluxel/commands'
import { createArgvRouter, toCli } from '@pluxel/commands/argv'
import { Commands, type CommandMount } from '@pluxel/services/commands'
import { Cli, encodeJson } from '@embedded-launcher/sdk'
@Plugin({ displayName: 'CLI Carrier' })
export class CliCarrier extends BasePlugin {
	private readonly router = createArgvRouter<CommandContext, string>()
	private mount!: CommandMount
	protected override init() {
		this.mount = this.ctx.require(Commands).createMount()
		this.ctx.require(Cli).publish(async (argv, signal) => {
			const resolved = this.router.resolve(argv)
			if (!resolved)
				return {
					ok: false,
					error: { code: 'COMMAND_NOT_FOUND', message: 'Usage: calc <expression>' },
				}
			const result = await resolved.command.execute(resolved.candidate, { signal })
			return result.isOk()
				? { ok: true, value: JSON.parse(result.value) }
				: { ok: false, error: { code: result.error.code, message: result.error.message } }
		})
	}
	publish<O>(command: Command<{ expression: string }, O>) {
		return this.mount.bind(command, {
			async handle(definition, candidate, context) {
				const result = await definition.execute(candidate as { expression: string }, context)
				if (result.isErr()) return Result.err(result.error)
				return Result.ok(encodeJson(result.value))
			},
			install: (endpoint) =>
				this.router.bind(toCli(endpoint, { routes: ['calc'], positionals: ['expression'] })),
		})
	}
}
