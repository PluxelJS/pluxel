import type { CommandContext } from 'gunshi'
import { ScriptExecutionError } from '@pluxel/host/agent'

/** Reject ignored flags and excess positionals before an operational command opens its target. */
export function validateCommandOptions(
	ctx: Pick<CommandContext, 'args' | 'tokens' | 'positionals' | 'commandPath'>,
): void {
	const allowed = new Set(['help', 'version'])
	const short = new Set(['h', 'v'])
	for (const [name, argument] of Object.entries(ctx.args)) {
		if (argument.type === 'positional') continue
		allowed.add(name)
		if (argument.short) short.add(argument.short)
		if (argument.type === 'boolean' && argument.negatable) allowed.add(`no-${name}`)
	}
	for (const token of ctx.tokens) {
		if (token.kind !== 'option') continue
		const names = token.rawName?.startsWith('--') ? allowed : short
		if (!token.name || !names.has(token.name))
			throw new ScriptExecutionError(
				'invalid_input',
				`Unknown ${ctx.commandPath[0] ?? 'command'} option ${token.rawName ?? token.name ?? '(unnamed)'}`,
			)
	}
	const declared = Object.values(ctx.args).filter(
		(argument) => argument.type === 'positional',
	).length
	if (ctx.positionals.length > ctx.commandPath.length + declared)
		throw new ScriptExecutionError(
			'invalid_input',
			'Unexpected argument; check the selected command’s --help',
		)
}
