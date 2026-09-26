import { deepFreeze, isDeepFrozen } from './internal/freeze'
import {
	assertJsonValue,
	cloneJsonValue,
	isStrictJsonSnapshot,
	markStrictJsonSnapshot,
} from './internal/json'
import {
	CommandError,
	type Command,
	type CommandContext,
	type CommandDescriptor,
	type DirectCommand,
} from './types'

/**
 * Capture a command's descriptor and execute function without publishing it.
 * The frozen facade preserves the original receiver and execution lifetime. It does not
 * validate inputs, supervise results, or turn an existing publication into a new definition.
 */
export function snapshotCommand<I, O, Ctx extends CommandContext>(
	command: Command<I, O, Ctx> & ({ readonly dispose: unknown } | { readonly mounted: true }),
): Command<I, O, Ctx> & { readonly mounted: true }
export function snapshotCommand<I, O, Ctx extends CommandContext>(
	command: DirectCommand<I, O, Ctx>,
): DirectCommand<I, O, Ctx>
export function snapshotCommand<I, O, Ctx extends CommandContext>(
	command: Command<I, O, Ctx>,
): Command<I, O, Ctx> & { readonly mounted?: true }
export function snapshotCommand<I, O, Ctx extends CommandContext>(
	command: Command<I, O, Ctx>,
): Command<I, O, Ctx> {
	try {
		const { name, execute } = command
		if (typeof name !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(name)) {
			throw new TypeError(
				'Command name must contain 1-128 letters, digits, dots, underscores, or hyphens',
			)
		}
		if (typeof execute !== 'function') throw new TypeError('Command execute must be a function')
		const descriptor = descriptorSnapshot(command.descriptor)
		if (descriptor.name !== name) throw new TypeError('Command and descriptor names must match')
		if (
			typeof descriptor.description !== 'string' ||
			!descriptor.description.trim() ||
			descriptor.description.length > 4_000
		) {
			throw new TypeError('Command description must contain 1-4000 characters')
		}
		if (!descriptor.inputSchema || descriptor.inputSchema.type !== 'object') {
			throw new TypeError('Command input must be an object schema')
		}
		const invoke: Command<I, O, Ctx>['execute'] = (candidate, ...context) =>
			Reflect.apply(execute, command, [candidate, ...context])
		return Object.freeze({
			name,
			descriptor,
			execute: invoke,
			// A snapshot must not launder an existing publication into a mountable definition.
			...('dispose' in command || 'mounted' in command ? { mounted: true as const } : {}),
		})
	} catch (cause) {
		throw new CommandError('COMMAND_CONFIG', 'Invalid command configuration', { cause })
	}
}

function descriptorSnapshot(descriptor: CommandDescriptor): CommandDescriptor {
	if (isStrictJsonSnapshot(descriptor)) return descriptor
	if (isDeepFrozen(descriptor)) {
		assertJsonValue(descriptor)
		return markStrictJsonSnapshot(descriptor)
	}
	return markStrictJsonSnapshot(deepFreeze(cloneJsonValue(descriptor) as CommandDescriptor))
}
