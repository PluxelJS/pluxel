export { Result } from 'better-result'
export { defineCommand } from './define'
export { snapshotCommand } from './snapshot'
export { createCommandRegistry } from './registry'
export type { CommandCatalogSnapshot, CommandRegistry } from './registry'
export { CommandError } from './types'
export type {
	ArgumentSyntaxReason,
	AnyCommand,
	Command,
	CommandContext,
	CommandContextArgs,
	CommandDescriptor,
	CommandErrorCode,
	CommandErrorDetails,
	CommandErrorKind,
	CommandFailure,
	CommandRegistration,
	DefineCommandConfig,
	DirectCommand,
	Infer,
	ObjectSchema,
	Registration,
	Schema,
	ValidationIssue,
	Wire,
} from './types'
