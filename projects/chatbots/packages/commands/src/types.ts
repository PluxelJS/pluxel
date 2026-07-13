import type { ChatUser, PermissionEffect } from '@repo/chatbots-access'
import type { ChatPayload } from '@repo/chatbots-contracts'
import type { ChatHandlerContext } from '@repo/chatbots-hub'

export type ParsedCommandLine = {
	tokens: string[]
	tokenSpans: Array<{ start: number; end: number }>
	positionals: string[]
	flags: Readonly<Record<string, string | boolean | readonly string[]>>
}
export type ChatCommandContext = ChatHandlerContext & {
	user: ChatUser
	args: readonly string[]
	rawArgs: string
	flags: ParsedCommandLine['flags']
}
export type ChatCommandPermission =
	| false
	| string
	| { node?: string; defaultEffect?: PermissionEffect }
export type ChatCommand = {
	/** Space-separated hierarchical route, for example `admin reload`. */
	name: string
	title?: string
	description: string
	usage?: string
	aliases?: readonly string[]
	hidden?: boolean
	/** Commands are denied by default until explicitly granted. Use false for public commands. */
	permission?: ChatCommandPermission
	execute(context: ChatCommandContext): ChatPayload | void | Promise<ChatPayload | void>
}
export type RegisteredChatCommand = Pick<
	ChatCommand,
	'name' | 'title' | 'description' | 'usage' | 'aliases' | 'hidden' | 'permission'
>
export type ChatCommandMiddleware = (
	context: ChatCommandContext,
	next: () => Promise<ChatPayload | void>,
) => ChatPayload | void | Promise<ChatPayload | void>
export type RegisteredCommand = ChatCommand & { name: string; route: readonly string[] }

export class ChatCommandError extends Error {
	constructor(
		public readonly code: 'PARSE' | 'FORBIDDEN' | 'USAGE',
		message: string,
	) {
		super(message)
		this.name = 'ChatCommandError'
	}
}
