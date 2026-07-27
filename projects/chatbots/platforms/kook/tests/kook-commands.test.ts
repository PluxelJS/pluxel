import { defineCommand } from '@pluxel/commands'
import { tail } from '@pluxel/commands/argv'
import { Type, obj } from '@pluxel/commands/typebox'
import { createRuntimeContext } from '@pluxel/runtime/test'
import { describe, expect, it, vi } from 'vitest'
import wretch from 'wretch'
import { KookBot } from '../src/bot/bot.ts'
import type { KookEvent } from '../src/bot/events.types.ts'
import { createKookPluginEvents } from '../src/bot/events.factory.ts'
import { KookBotManager } from '../src/bot/manager.ts'
import { KookCommandCarrier, type KookCommandContext, type KookCommands } from '../src/commands.ts'

const input = obj({ text: Type.String({ minLength: 1 }) })
const output = obj({ reply: Type.String() })

const portableCommand = defineCommand({
	name: 'portable.echo',
	description: 'Echo text without requiring carrier-specific context.',
	behavior: { kind: 'query', world: 'closed' },
	input,
	output,
	execute: ({ text }) => ({ reply: text }),
})

const kookCommand = defineCommand<typeof input, typeof output, KookCommandContext>({
	name: 'kook.echo',
	description: 'Echo text with KOOK invocation facts.',
	behavior: { kind: 'query', world: 'closed' },
	input,
	output,
	execute: ({ text }, context) => ({
		reply: `${context.carrier}:${context.bot.id}:${context.event.author_id}:${text}`,
	}),
})

function assertContextDirection(
	commands: KookCommands,
	runtime: ReturnType<typeof createRuntimeContext>,
) {
	commands.register(portableCommand, { routes: ['portable'], tail: tail.text('text') })
	// @ts-expect-error Runtime cannot execute a command that requires KOOK invocation context.
	runtime.ctx.commands.register(kookCommand)
}
void assertContextDirection

function event(source: string, patch: Partial<KookEvent> = {}): KookEvent {
	return {
		type: 9,
		target_id: 'channel-1',
		author_id: 'user-1',
		content: source,
		msg_id: 'message-1',
		msg_timestamp: 1_700_000_000_000,
		channel_type: 'GROUP',
		extra: {
			guild_id: 'guild-1',
			author: { username: 'alice', nickname: 'Alice', bot: false },
			kmarkdown: { raw_content: source },
		},
		...patch,
	}
}

describe('KOOK command carrier', () => {
	it('consumes matched commands before ordinary event consumers', async () => {
		const runtime = createRuntimeContext()
		const bot = new KookBot({
			id: 'ordered',
			ctx: runtime.ctx,
			http: wretch(),
			token: 'secret',
		})
		const dispatchCommand = vi
			.fn<(bot: KookBot, event: KookEvent, signal: AbortSignal) => Promise<boolean>>()
			.mockResolvedValueOnce(true)
			.mockResolvedValueOnce(false)
		const manager = new KookBotManager({
			ctx: runtime.ctx,
			http: wretch(),
			events: createKookPluginEvents(runtime.ctx),
			dispatchCommand,
		})
		const consume = vi.fn()
		manager.registerEventConsumer('downstream', consume)
		const dispatchEvent = (
			manager as unknown as {
				dispatchEvent(bot: KookBot, event: KookEvent, signal: AbortSignal): Promise<void>
			}
		).dispatchEvent.bind(manager)

		try {
			await dispatchEvent(bot, event('/owned'), new AbortController().signal)
			expect(consume).not.toHaveBeenCalled()
			await dispatchEvent(bot, event('/unmatched'), new AbortController().signal)
			expect(consume).toHaveBeenCalledOnce()
		} finally {
			manager.dispose()
			bot.$.destroy()
			await runtime.dispose()
		}
	})

	it('reuses one base-context command in runtime and KOOK', async () => {
		const runtime = createRuntimeContext()
		const requests: Request[] = []
		const bot = new KookBot({
			id: 'portable',
			ctx: runtime.ctx,
			http: wretch().fetchPolyfill(async (request, init) => {
				requests.push(new Request(request, init))
				return Response.json({
					code: 0,
					message: 'ok',
					data: { msg_id: 'reply-1', msg_timestamp: 1, nonce: 'nonce-1' },
				})
			}),
			token: 'secret',
		})
		const carrier = new KookCommandCarrier(runtime.ctx)
		const runtimeRegistration = runtime.ctx.commands.register(portableCommand)
		const kookRegistration = carrier.register(portableCommand, {
			routes: ['portable'],
			tail: tail.text('text'),
			respond: async ({ reply }, context) => {
				await context.reply(reply)
			},
		})

		try {
			await expect(
				runtime.ctx.commands.executeOrThrow('portable.echo', { text: 'runtime' }),
			).resolves.toEqual({ reply: 'runtime' })
			await expect(
				carrier.dispatch(bot, event('/portable kook'), new AbortController().signal),
			).resolves.toBe(true)
			expect(await requests[0]?.json()).toMatchObject({ content: 'kook' })
		} finally {
			kookRegistration.dispose()
			runtimeRegistration.dispose()
			carrier.dispose()
			bot.$.destroy()
			await runtime.dispose()
		}
	})

	it('constructs KOOK context, replies, and reclaims route bindings', async () => {
		const runtime = createRuntimeContext()
		const requests: Request[] = []
		const bot = new KookBot({
			id: 'community',
			ctx: runtime.ctx,
			http: wretch().fetchPolyfill(async (request, init) => {
				requests.push(new Request(request, init))
				return Response.json({
					code: 0,
					message: 'ok',
					data: { msg_id: 'reply-1', msg_timestamp: 1, nonce: 'nonce-1' },
				})
			}),
			token: 'secret',
		})
		const carrier = new KookCommandCarrier(runtime.ctx)
		const ownerEffects = runtime.ctx.effects.scope({ tag: 'KookCommandOwner' })
		const registration = carrier.register(kookCommand, {
			routes: ['echo'],
			tail: tail.text('text'),
			respond: async ({ reply }, context) => {
				await context.reply(reply)
			},
		})
		ownerEffects.own(registration)

		try {
			expect(carrier.list()).toEqual([
				expect.objectContaining({ name: 'kook.echo', routes: ['echo'] }),
			])
			await expect(
				carrier.dispatch(bot, event('/echo hello world'), new AbortController().signal),
			).resolves.toBe(true)
			expect(requests).toHaveLength(1)
			expect(requests[0]?.url).toContain('/api/v3/message/create')
			expect(await requests[0]?.json()).toMatchObject({
				target_id: 'channel-1',
				quote: 'message-1',
				content: 'kook:community:user-1:hello world',
			})

			await ownerEffects.dispose()
			expect(carrier.list()).toEqual([])
			await expect(
				carrier.dispatch(bot, event('/echo ignored'), new AbortController().signal),
			).resolves.toBe(false)
			expect(requests).toHaveLength(1)
		} finally {
			await ownerEffects.dispose()
			carrier.dispose()
			bot.$.destroy()
			await runtime.dispose()
		}
	})

	it('lets an invocation that already resolved finish after route disposal', async () => {
		const runtime = createRuntimeContext()
		const fetch = vi.fn(async () =>
			Response.json({
				code: 0,
				message: 'ok',
				data: { msg_id: 'reply-1', msg_timestamp: 1, nonce: 'nonce-1' },
			}),
		)
		const bot = new KookBot({
			id: 'in-flight',
			ctx: runtime.ctx,
			http: wretch().fetchPolyfill(fetch),
			token: 'secret',
		})
		const started = Promise.withResolvers<void>()
		const gate = Promise.withResolvers<void>()
		const delayed = defineCommand<typeof input, typeof output, KookCommandContext>({
			name: 'kook.delayed',
			description: 'Wait before producing one reply.',
			behavior: { kind: 'query', world: 'closed' },
			input,
			output,
			async execute({ text }) {
				started.resolve()
				await gate.promise
				return { reply: text }
			},
		})
		const carrier = new KookCommandCarrier(runtime.ctx)
		const registration = carrier.register(delayed, {
			routes: ['delayed'],
			tail: tail.text('text'),
			respond: async ({ reply }, context) => {
				await context.reply(reply)
			},
		})

		try {
			const invocation = carrier.dispatch(
				bot,
				event('/delayed complete'),
				new AbortController().signal,
			)
			await started.promise
			registration.dispose()
			gate.resolve()
			await expect(invocation).resolves.toBe(true)
			expect(fetch).toHaveBeenCalledOnce()
		} finally {
			gate.resolve()
			carrier.dispose()
			bot.$.destroy()
			await runtime.dispose()
		}
	})

	it('leaves unmatched messages for downstream consumers and handles matched input failures', async () => {
		const runtime = createRuntimeContext()
		const fetch = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
			async () =>
				Response.json({
					code: 0,
					message: 'ok',
					data: { msg_id: 'reply-1', msg_timestamp: 1, nonce: 'nonce-1' },
				}),
		)
		const bot = new KookBot({
			id: 'community',
			ctx: runtime.ctx,
			http: wretch().fetchPolyfill(fetch),
			token: 'secret',
		})
		const carrier = new KookCommandCarrier(runtime.ctx)
		carrier.register(kookCommand, {
			routes: ['echo'],
			tail: tail.text('text'),
		})

		try {
			await expect(
				carrier.dispatch(bot, event('/unknown value'), new AbortController().signal),
			).resolves.toBe(false)
			expect(fetch).not.toHaveBeenCalled()

			await expect(
				carrier.dispatch(bot, event('/echo'), new AbortController().signal),
			).resolves.toBe(true)
			expect(fetch).toHaveBeenCalledOnce()
			const request = new Request(fetch.mock.calls[0]![0], fetch.mock.calls[0]![1])
			expect(await request.json()).toMatchObject({ content: 'Invalid command input' })
		} finally {
			carrier.dispose()
			bot.$.destroy()
			await runtime.dispose()
		}
	})
})
