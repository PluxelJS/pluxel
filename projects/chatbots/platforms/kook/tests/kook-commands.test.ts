import { defineCommand, type CommandContext } from '@pluxel/commands'
import { tail } from '@pluxel/commands/argv'
import { Type, obj } from '@pluxel/commands/typebox'
import {
	BasePlugin,
	createRuntimeContext,
	createRuntimeHost,
	Plugin,
	setParamTokens,
} from '@pluxel/runtime/test'
import { describe, expect, it, vi } from 'vitest'
import wretch from 'wretch'
import { KookBot } from '../src/bot/bot.ts'
import type { KookEvent } from '../src/bot/events.types.ts'
import { createKookPluginEvents } from '../src/bot/events.factory.ts'
import { KookBotManager } from '../src/bot/manager.ts'
import { defineKookCommand, KookCommandCarrier, type KookCommands } from '../src/commands.ts'
import { KookPlugin } from '../src/plugin.ts'

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

interface ActorCommandContext extends CommandContext {
	readonly actorId: string
}

const actorCommand = defineCommand<typeof input, typeof output, ActorCommandContext>({
	name: 'portable.actor',
	description: 'Read one carrier-projected actor identity.',
	behavior: { kind: 'query', world: 'closed' },
	input,
	output,
	execute: ({ text }, context) => ({ reply: `${context.actorId}:${text}` }),
})

const kookCommand = defineKookCommand({
	name: 'kook.echo',
	description: 'Echo text with KOOK invocation facts.',
	behavior: { kind: 'query', world: 'closed' },
	input,
	execute: async ({ text }, context) => {
		await context.reply(`${context.carrier}:${context.bot.id}:${context.event.author_id}:${text}`)
	},
})

@Plugin({ name: 'KookCommandTestHttpPlugin' })
class KookCommandTestHttpPlugin extends BasePlugin {
	readonly client = wretch()
}

@Plugin({ name: 'KookCommandConsumerPlugin' })
class KookCommandConsumerPlugin extends BasePlugin {
	constructor(private readonly kook: KookPlugin) {
		super()
	}

	override init(): void {
		this.kook.commands.register(kookCommand, {
			routes: ['consumer-owned'],
			tail: tail.text('text'),
		})
	}
}

setParamTokens(KookPlugin, [KookCommandTestHttpPlugin])
setParamTokens(KookCommandConsumerPlugin, [KookPlugin])

function assertContextDirection(
	commands: KookCommands,
	runtime: ReturnType<typeof createRuntimeContext>,
) {
	commands.bind(portableCommand, {
		routes: ['portable'],
		tail: tail.text('text'),
		respond: () => undefined,
	})
	commands.bind(actorCommand, {
		routes: ['actor'],
		tail: tail.text('text'),
		context: (source) => ({ signal: source.signal, actorId: source.event.author_id }),
		respond: () => undefined,
	})
	// @ts-expect-error A command with required custom context needs an explicit KOOK projection.
	commands.bind(actorCommand, {
		routes: ['actor-without-context'],
		tail: tail.text('text'),
		respond: () => undefined,
	})
	commands.register(kookCommand, { routes: ['kook'], tail: tail.text('text') })
	// @ts-expect-error Portable commands need an explicit KOOK output projection.
	commands.register(portableCommand, { routes: ['invalid-portable'], tail: tail.text('text') })
	// @ts-expect-error KOOK-native commands own their reply and cannot be projected again.
	commands.bind(kookCommand, {
		routes: ['invalid-kook'],
		tail: tail.text('text'),
		respond: () => undefined,
	})
	// @ts-expect-error A portable command binding must define its terminal KOOK response.
	commands.bind(portableCommand, {
		routes: ['missing-response'],
		tail: tail.text('text'),
	})
	defineKookCommand({
		name: 'kook.invalid-output',
		description: 'Invalid KOOK command shape.',
		behavior: { kind: 'query', world: 'closed' },
		input,
		// @ts-expect-error KOOK-native commands cannot declare structured output.
		output,
		execute: () => undefined,
	})
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
	it('attributes injected KookPlugin registrations to the consuming plugin', async () => {
		const host = createRuntimeHost({ workbench: false })
		try {
			host.add([KookCommandTestHttpPlugin, KookPlugin, KookCommandConsumerPlugin])
			host.cfg(KookPlugin).set({ config: { prefix: '!' } })
			const started = await host.commitAllowFail()
			expect(started.lifecycleReport.issues).toEqual([])
			expect(host.require(KookPlugin).commandPrefix).toBe('!')
			expect(host.require(KookPlugin).commands.list()).toEqual([
				expect.objectContaining({ name: 'kook.echo', routes: ['consumer-owned'] }),
			])

			host.remove(KookCommandConsumerPlugin)
			await host.commit()
			expect(host.isRunning(KookPlugin)).toBe(true)
			expect(host.require(KookPlugin).commands.list()).toEqual([])
		} finally {
			await host.dispose()
		}
	})

	it('keeps native registration and portable projection as disjoint contracts', async () => {
		const runtime = createRuntimeContext()
		const carrier = new KookCommandCarrier(runtime.ctx)
		const commands = carrier.forOwner(runtime.ctx)

		try {
			expect(() =>
				commands.register(portableCommand as never, {
					routes: ['invalid-portable'],
					tail: tail.text('text'),
				}),
			).toThrow('commands.register() requires a command from defineKookCommand()')
			expect(() =>
				commands.bind(kookCommand as never, {
					routes: ['invalid-kook'],
					tail: tail.text('text'),
					respond: () => undefined,
				}),
			).toThrow('commands.bind() accepts portable commands')
			expect(() =>
				commands.bind(portableCommand, {
					routes: ['missing-response'],
					tail: tail.text('text'),
				} as never),
			).toThrow('commands.bind() requires a respond function')
			expect(() =>
				defineKookCommand({
					name: 'kook.invalid-output',
					description: 'Invalid KOOK command shape.',
					behavior: { kind: 'query', world: 'closed' },
					input,
					output,
					execute: ({ text }: { text: string }) => ({ reply: text }),
				} as never),
			).toThrow('defineKookCommand() does not accept output')
		} finally {
			carrier.dispose()
			await runtime.dispose()
		}
	})

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
		const commands = carrier.forOwner(runtime.ctx)
		const runtimeRegistration = runtime.ctx.commands.register(portableCommand)
		const kookRegistration = commands.bind(portableCommand, {
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

	it('projects KOOK invocation facts into a required portable command context', async () => {
		const runtime = createRuntimeContext()
		const requests: Request[] = []
		const bot = new KookBot({
			id: 'projected',
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
		const registration = carrier.forOwner(runtime.ctx).bind(actorCommand, {
			routes: ['actor'],
			tail: tail.text('text'),
			context: (source) => ({ signal: source.signal, actorId: source.event.author_id }),
			respond: async ({ reply }, source) => {
				await source.reply(reply)
			},
		})

		try {
			await expect(
				carrier.dispatch(bot, event('/actor hello'), new AbortController().signal),
			).resolves.toBe(true)
			expect(await requests[0]?.json()).toMatchObject({ content: 'user-1:hello' })
		} finally {
			registration.dispose()
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
		const carrier = new KookCommandCarrier(runtime.ctx, '.')
		const commands = carrier.forOwner(runtime.ctx)
		commands.register(kookCommand, {
			routes: ['echo'],
			tail: tail.text('text'),
		})

		try {
			expect(carrier.list()).toEqual([
				expect.objectContaining({ name: 'kook.echo', routes: ['echo'] }),
			])
			await expect(
				carrier.dispatch(bot, event('/echo ignored'), new AbortController().signal),
			).resolves.toBe(false)
			await expect(
				carrier.dispatch(bot, event('.echo hello world'), new AbortController().signal),
			).resolves.toBe(true)
			expect(requests).toHaveLength(1)
			expect(requests[0]?.url).toContain('/api/v3/message/create')
			expect(await requests[0]?.json()).toMatchObject({
				target_id: 'channel-1',
				quote: 'message-1',
				content: 'kook:community:user-1:hello world',
			})

			await runtime.ctx.effects.dispose()
			expect(carrier.list()).toEqual([])
			await expect(
				carrier.dispatch(bot, event('.echo ignored'), new AbortController().signal),
			).resolves.toBe(false)
			expect(requests).toHaveLength(1)
		} finally {
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
		const delayed = defineKookCommand({
			name: 'kook.delayed',
			description: 'Wait before producing one reply.',
			behavior: { kind: 'query', world: 'closed' },
			input,
			async execute({ text }, context) {
				started.resolve()
				await gate.promise
				await context.reply(text)
			},
		})
		const carrier = new KookCommandCarrier(runtime.ctx)
		const commands = carrier.forOwner(runtime.ctx)
		const registration = commands.register(delayed, {
			routes: ['delayed'],
			tail: tail.text('text'),
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

	it('aborts reply IO and drains admitted invocations when the registering owner stops', async () => {
		const runtime = createRuntimeContext()
		const owner = runtime.ctx.extend({ name: 'KookCommandConsumer' })
		const requestStarted = Promise.withResolvers<AbortSignal>()
		const handlerExited = Promise.withResolvers<void>()
		const order: string[] = []
		const bot = new KookBot({
			id: 'owner-cancelled',
			ctx: runtime.ctx,
			http: wretch().fetchPolyfill(async (request, init) => {
				const requestSignal = new Request(request, init).signal
				requestStarted.resolve(requestSignal)
				return new Promise<Response>((_resolve, reject) => {
					const abort = () => {
						order.push('io-abort')
						reject(requestSignal.reason)
					}
					if (requestSignal.aborted) abort()
					else requestSignal.addEventListener('abort', abort, { once: true })
				})
			}),
			token: 'secret',
		})
		const command = defineKookCommand({
			name: 'kook.owner-cancelled',
			description: 'Reply until the registering owner stops.',
			behavior: { kind: 'query', world: 'open' },
			input,
			async execute({ text }, context) {
				try {
					await context.reply(text)
				} finally {
					order.push('handler-exit')
					handlerExited.resolve()
				}
			},
		})
		const carrier = new KookCommandCarrier(runtime.ctx)
		const commands = carrier.forOwner(owner)
		commands.register(command, {
			routes: ['owner-cancelled'],
			tail: tail.text('text'),
		})

		try {
			const invocation = carrier.dispatch(
				bot,
				event('/owner-cancelled pending'),
				new AbortController().signal,
			)
			const requestSignal = await requestStarted.promise
			expect(requestSignal.aborted).toBe(false)

			const stopping = owner.effects.dispose().then(() => order.push('owner-disposed'))
			await handlerExited.promise
			await expect(invocation).resolves.toBe(true)
			await stopping

			expect(requestSignal.aborted).toBe(true)
			expect(order).toEqual(['io-abort', 'handler-exit', 'owner-disposed'])
			expect(carrier.list()).toEqual([])
			expect(() =>
				commands.register(command, {
					routes: ['stale-owner'],
					tail: tail.text('text'),
				}),
			).toThrow('Effects service is disposed')
			expect(carrier.list()).toEqual([])
		} finally {
			await owner.effects.dispose()
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
		const commands = carrier.forOwner(runtime.ctx)
		commands.register(kookCommand, {
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
