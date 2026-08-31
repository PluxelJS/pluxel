import { constraint, issue } from './types'

export { defineCommand } from './define'
export { createCommandRegistry } from './registry'
export type { CommandCatalogSnapshot, CommandRegistry } from './registry'
export { CommandError } from './types'

export type {
	ArgumentSyntaxReason,
	AnyCommand,
	Command,
	CommandBehavior,
	CommandContext,
	CommandDescriptor,
	CommandExample,
	CommandErrorCode,
	CommandErrorDetails,
	CommandErrorKind,
	CommandRegistration,
	DefineCommandConfig,
	DirectCommand,
	Infer,
	InstalledCommand,
	ObjectSchema,
	OutputCommandDefinition,
	Registration,
	Schema,
	ValidationIssue,
	Validator,
	VoidCommandDefinition,
	Wire,
} from './types'

export const validation = { issue, constraint } as const
