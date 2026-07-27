import type { CommandContext } from '@pluxel/commands'
import type { ArgvBinding, ArgvCommandDescriptor } from '@pluxel/commands/argv'
import type { ChatUser, PermissionEffect } from '@repo/chatbots-access'
import type { ChatPayload } from '@repo/chatbots-contracts'
import type { ChatHandlerContext } from '@repo/chatbots-hub'

/** Invocation facts available when a command is carried by ChatHub. */
export interface ChatCommandContext extends CommandContext, ChatHandlerContext {
	readonly signal: AbortSignal
	readonly user: ChatUser
}

export type ChatCommandPermission =
	| false
	| string
	| { node?: string; defaultEffect?: PermissionEffect }

export type ChatCommandBinding<Input, Output> = ArgvBinding<Input> & {
	/** Commands are denied by default until explicitly granted. Use false for public commands. */
	permission?: ChatCommandPermission
	/** Omit this command from ordinary command discovery. */
	hidden?: boolean
	/** Project a validated command result to a ChatHub payload. Omit when the handler replies itself. */
	respond?: (
		output: Output,
		context: ChatCommandContext,
	) => ChatPayload | undefined | Promise<ChatPayload | undefined>
}

export type ChatCommandDescriptor = ArgvCommandDescriptor & {
	readonly hidden: boolean
	readonly permission?: ChatCommandPermission
}

export type ChatCommandMiddleware = (
	context: ChatCommandContext,
	next: () => Promise<unknown>,
) => unknown | Promise<unknown>
