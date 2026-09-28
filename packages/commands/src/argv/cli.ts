import type { Command, CommandContext } from '../types'
import { compileEntry, type CompiledEntry } from './compile'
import type { ArgvBinding, ArgvCommandDescriptor } from './types'

const cliBrand: unique symbol = Symbol('pluxel.cli')

/** Validated argv projection of one Command, ready for a router to publish. */
export interface CliCommand<I, O, Ctx extends CommandContext> {
	readonly [cliBrand]: true
	readonly command: Command<I, O, Ctx>
	readonly descriptor: ArgvCommandDescriptor
}

const entries = new WeakMap<object, CompiledEntry<any>>()

export function toCli<I, O, Ctx extends CommandContext>(
	command: Command<I, O, Ctx>,
	syntax: ArgvBinding<I>,
): CliCommand<I, O, Ctx> {
	const entry = compileEntry(command, syntax)
	const projection = Object.freeze({
		[cliBrand]: true as const,
		command,
		descriptor: entry.descriptor,
	})
	entries.set(projection, entry)
	return projection
}

export function compiledCliCommand<Ctx extends CommandContext>(
	projection: CliCommand<any, any, Ctx>,
): CompiledEntry<Ctx> {
	const entry = entries.get(projection)
	if (!entry) throw new TypeError('Expected a toCli() projection')
	return entry
}
