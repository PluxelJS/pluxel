import { defineCommand, type CommandContext } from '@pluxel/commands'
import { Type, obj } from '@pluxel/commands/typebox'
import { createRuntimeContext } from '@pluxel/runtime/test'
import { ChatAccessPlugin, type ChatUser } from '@repo/chatbots-access'
import type { ChatMessage } from '@repo/chatbots-contracts'
import type { ChatHandlerContext } from '@repo/chatbots-hub'
import { describe, expect, it, vi } from 'vitest'
import { runCommandMiddleware } from '../src/middleware.ts'
import { ChatCommandCarrier } from '../src/plugin.ts'
import type { ChatCommandContext } from '../src/types.ts'

const emptyInput = obj({})
const textOutput = obj({ text: Type.String() })

const portableCommand = defineCommand({
	name: 'portable.echo',
	description: 'A portable command.',
	behavior: { kind: 'query', world: 'closed' },
	input: obj({ value: Type.String() }),
	output: textOutput,
	execute: ({ value }) => ({ text: value }),
})

const chatCommand = defineCommand<typeof emptyInput, typeof textOutput, ChatCommandContext>({
	name: 'chat.identity',
	description: 'A command requiring ChatHub facts.',
	behavior: { kind: 'query', world: 'closed' },
	input: emptyInput,
	output: textOutput,
	execute: (_input, context) => ({ text: context.user.id }),
})

function assertContextDirection(
	carrier: ChatCommandCarrier,
	runtime: ReturnType<typeof createRuntimeContext>,
) {
	carrier.register(portableCommand, { routes: ['portable'], positionals: ['value'] })
	// @ts-expect-error Runtime cannot execute a command that requires ChatHub invocation facts.
	runtime.ctx.commands.register(chatCommand)
}
void assertContextDirection

describe('Chat command carrier', () => {
	it('reuses a base-context command and constructs typed ChatHub context', async () => {
		const { carrier } = fixture()
		carrier.register(portableCommand, {
			routes: ['portable'],
			positionals: ['value'],
			permission: false,
			respond: ({ text }, context) => `${context.message.platform}:${text}`,
		})
		carrier.register(chatCommand, {
			routes: ['identity'],
			permission: false,
			respond: ({ text }) => text,
		})

		const portable = invocation('/portable hello')
		await expect(carrier.dispatch(portable.context)).resolves.toBe('stop')
		expect(portable.replies).toEqual(['telegram:hello'])

		const identity = invocation('/identity')
		await carrier.dispatch(identity.context)
		expect(identity.replies).toEqual(['user-1'])
	})

	it('uses schema-derived routes, aliases, positionals, and flags', async () => {
		const { carrier } = fixture()
		const execute = vi.fn(({ target, force }: { target: string; force?: boolean }) => ({
			text: `${target}:${force ?? false}`,
		}))
		const command = defineCommand({
			name: 'chat.reload',
			description: 'Reload one target.',
			behavior: { kind: 'mutation', destructive: false, idempotent: true, world: 'closed' },
			input: obj({
				target: Type.String(),
				force: Type.Optional(Type.Boolean()),
			}),
			output: textOutput,
			execute,
		})
		carrier.register(command, {
			routes: ['admin reload', 'ops reload'],
			positionals: ['target'],
			options: { force: { aliases: ['f'] } },
			permission: false,
			respond: ({ text }) => text,
		})

		const call = invocation('/ops reload worker -f')
		await carrier.dispatch(call.context)
		expect(execute).toHaveBeenCalledWith(
			{ target: 'worker', force: true },
			expect.objectContaining({ signal: call.context.signal }),
		)
		expect(call.replies).toEqual(['worker:true'])
		expect(carrier.list()).toEqual([
			expect.objectContaining({
				name: 'chat.reload',
				routes: ['admin reload', 'ops reload'],
				hidden: false,
			}),
		])
	})

	it('rejects route conflicts and reclaims routes and permissions', () => {
		const { carrier, declarations } = fixture()
		const first = carrier.register(chatCommand, { routes: ['identity'] })
		expect(declarations).toEqual(['cmd.chat.identity'])
		expect(() =>
			carrier.register(portableCommand, {
				routes: ['identity'],
				positionals: ['value'],
			}),
		).toThrow(/route/i)

		first.dispose()
		expect(declarations).toEqual([])
		expect(() =>
			carrier.register(portableCommand, {
				routes: ['identity'],
				positionals: ['value'],
				permission: false,
			}),
		).not.toThrow()
	})

	it('rolls route registration back when permission declaration fails', () => {
		const access = fakeAccess()
		const declare = vi.spyOn(access, 'declare').mockImplementationOnce(() => {
			throw new Error('permission conflict')
		})
		const carrier = new ChatCommandCarrier(access, { warn() {} })
		expect(() => carrier.register(chatCommand, { routes: ['identity'] })).toThrow(
			'permission conflict',
		)
		expect(declare).toHaveBeenCalledWith({
			node: 'cmd.chat.identity',
			description: 'A command requiring ChatHub facts.',
			defaultEffect: 'deny',
		})
		expect(() =>
			carrier.register(portableCommand, {
				routes: ['identity'],
				positionals: ['value'],
				permission: false,
			}),
		).not.toThrow()
	})

	it('denies protected commands before execution', async () => {
		const access = fakeAccess()
		vi.spyOn(access, 'authorize').mockReturnValue(false)
		const carrier = new ChatCommandCarrier(access, { warn() {} })
		const execute = vi.fn(() => ({ text: 'private' }))
		const command = defineCommand({
			name: 'chat.private',
			description: 'Private command.',
			behavior: { kind: 'query', world: 'closed' },
			input: emptyInput,
			output: textOutput,
			execute,
		})
		carrier.register(command, { routes: ['private'], respond: ({ text }) => text })

		const call = invocation('/private')
		await expect(carrier.dispatch(call.context)).resolves.toBe('stop')
		expect(execute).not.toHaveBeenCalled()
		expect(access.authorize).toHaveBeenCalledWith('user-1', 'cmd.chat.private')
		expect(call.replies).toEqual(['没有权限执行此命令。'])
	})

	it('short-circuits matched validation failures and lets unknown routes fall through', async () => {
		const { carrier } = fixture()
		carrier.register(portableCommand, {
			routes: ['portable'],
			positionals: ['value'],
			permission: false,
		})

		const invalid = invocation('/portable')
		await expect(carrier.dispatch(invalid.context)).resolves.toBe('stop')
		expect(invalid.replies).toEqual(['Invalid command input'])

		const unknown = invocation('/not-ours anything')
		await expect(carrier.dispatch(unknown.context)).resolves.toBeUndefined()
		expect(unknown.replies).toEqual([])
	})

	it('accepts Telegram-qualified routes', async () => {
		const { carrier } = fixture()
		carrier.register(chatCommand, {
			routes: ['identity'],
			permission: false,
			respond: ({ text }) => text,
		})
		const call = invocation('/identity@my_bot')
		await carrier.dispatch(call.context)
		expect(call.replies).toEqual(['user-1'])
	})

	it('lets an invocation resolved before disposal retain its responder', async () => {
		const { carrier } = fixture()
		const started = Promise.withResolvers<void>()
		const gate = Promise.withResolvers<void>()
		const command = defineCommand({
			name: 'chat.delayed',
			description: 'Delayed command.',
			behavior: { kind: 'query', world: 'closed' },
			input: emptyInput,
			output: textOutput,
			async execute() {
				started.resolve()
				await gate.promise
				return { text: 'finished' }
			},
		})
		const registration = carrier.register(command, {
			routes: ['delayed'],
			permission: false,
			respond: ({ text }) => text,
		})
		const call = invocation('/delayed')
		const pending = carrier.dispatch(call.context)
		await started.promise
		registration.dispose()
		gate.resolve()

		await expect(pending).resolves.toBe('stop')
		expect(call.replies).toEqual(['finished'])
		expect(carrier.list()).toEqual([])
	})

	it('prevents middleware from executing downstream work twice', async () => {
		let executions = 0
		const context = {} as ChatCommandContext
		await expect(
			runCommandMiddleware(
				context,
				[
					async (_context, next) => {
						await next()
						await next()
					},
				],
				() => void executions++,
			),
		).rejects.toThrow('multiple times')
		expect(executions).toBe(1)
	})

	it('effect ownership reclaims command and middleware registrations', async () => {
		const runtime = createRuntimeContext()
		const { carrier } = fixture()
		const scope = runtime.ctx.effects.scope({ tag: 'ChatCommandOwner' })
		scope.own(carrier.register(chatCommand, { routes: ['identity'], permission: false }))
		scope.own(carrier.registerMiddleware('test', (_context, next) => next()))
		expect(carrier.list()).toHaveLength(1)

		await scope.dispose()
		expect(carrier.list()).toEqual([])
		expect(() => carrier.registerMiddleware('test', (_context, next) => next())).not.toThrow()
		await runtime.dispose()
	})

	it('does not add raw command input to fault logs', async () => {
		const logger = { warn: vi.fn() }
		const access = fakeAccess()
		const carrier = new ChatCommandCarrier(access, logger)
		const secretInput = obj({ value: Type.String() })
		const command = defineCommand<typeof secretInput, typeof textOutput, CommandContext>({
			name: 'portable.broken',
			description: 'Broken command.',
			behavior: { kind: 'query', world: 'closed' },
			input: secretInput,
			output: textOutput,
			execute() {
				throw new Error('failure')
			},
		})
		carrier.register(command, {
			routes: ['broken'],
			positionals: ['value'],
			permission: false,
		})
		const call = invocation('/broken super-secret-raw-argument')
		await carrier.dispatch(call.context)

		expect(logger.warn).toHaveBeenCalledOnce()
		expect(logger.warn.mock.calls[0]?.[1]).toMatchObject({ command: 'portable.broken' })
		expect(Object.keys(logger.warn.mock.calls[0]?.[1] ?? {})).toEqual(['command', 'error'])
		expect(call.replies).toEqual(['命令执行失败，请稍后重试。'])
	})
})

function fixture() {
	const access = fakeAccess()
	return {
		access,
		carrier: new ChatCommandCarrier(access, { warn() {} }),
		declarations: access.declarations,
	}
}

function fakeAccess() {
	const declarations: string[] = []
	const access = {
		declarations,
		resolveMessage: (_message: ChatMessage): ChatUser => ({
			id: 'user-1',
			displayName: 'Alice',
			identities: [],
			createdAt: 1,
			updatedAt: 1,
		}),
		declare: (input: { node: string }) => {
			declarations.push(input.node)
			return () => {
				const index = declarations.indexOf(input.node)
				if (index >= 0) declarations.splice(index, 1)
			}
		},
		authorize: (_userId: string, _node: string) => true,
	}
	return access as typeof access &
		Pick<ChatAccessPlugin, 'resolveMessage' | 'declare' | 'authorize'>
}

function invocation(text: string): { context: ChatHandlerContext; replies: unknown[] } {
	const replies: unknown[] = []
	const message: ChatMessage = {
		id: 'message-1',
		platform: 'telegram',
		accountId: 'default',
		conversation: { id: 'room-1', kind: 'group' },
		actor: { id: 'actor-1' },
		content: [{ type: 'text', text }],
		text,
		createdAt: 1,
	}
	return {
		replies,
		context: {
			message,
			signal: new AbortController().signal,
			async reply(content) {
				replies.push(content)
				return { messageId: `reply-${replies.length}` }
			},
			async send() {
				return { messageId: 'sent-1' }
			},
		},
	}
}
