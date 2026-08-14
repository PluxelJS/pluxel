import { constraint, issue } from './types'

export { defineCommand } from './define'
export { createCommandRegistry } from './registry'
export type { CommandRegistry } from './registry'
export { CommandError } from './types'

export type {
	ArgumentSyntaxReason,
	AnyCommand,
	Command,
	CommandBehavior,
	CommandContext,
	CommandDescriptor,
	CommandErr,
	CommandExample,
	CommandErrorCode,
	CommandErrorDetails,
	CommandErrorKind,
	CommandOk,
	CommandResult,
	DefineCommandConfig,
	Infer,
	ObjectSchema,
	Registration,
	Schema,
	ValidationIssue,
	Validator,
	VoidCommandDefinition,
	Wire,
} from './types'

export const validation = { issue, constraint } as const
