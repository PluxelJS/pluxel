import { BasePlugin, Plugin, setParamToken, withRuntimeHost } from '@pluxel/runtime/test'
import { defineCommand } from '@pluxel/commands'
import { Type, obj } from '@pluxel/commands/typebox'
import { describe, expect, it } from 'vitest'
import { DiscordPlugin } from '../src/plugin.ts'
import { DiscordBot } from '../src/bot/bot.ts'
import { resolveDiscordRestOptions } from '../src/bot/rest.ts'

@Plugin({ name: 'DiscordInteractionConsumerTestPlugin' })
class DiscordInteractionConsumerTestPlugin extends BasePlugin {
	constructor(private readonly discord: DiscordPlugin) {
		super()
	}

	override init(): void {
		this.discord.interactions.on('test:', () => undefined)
	}
}
setParamToken(DiscordInteractionConsumerTestPlugin, 0, DiscordPlugin)

const echo = defineCommand({
	name: 'test.echo',
	description: 'Echo one value.',
	behavior: { kind: 'query', world: 'open' },
	input: obj({ value: Type.String() }),
	output: obj({ value: Type.String() }),
	execute: ({ value }) => ({ value }),
})

@Plugin({ name: 'DiscordCommandOwnerTestPlugin' })
class DiscordCommandOwnerTestPlugin extends BasePlugin {
	constructor(private readonly discord: DiscordPlugin) {
		super()
	}

	override init(): void {
		this.discord.commands.bind(echo, {
			root: { name: 'test', description: 'Test commands' },
			subcommand: {
				name: 'echo',
				description: 'Echo one value',
				configure: (command) =>
					command.addStringOption((option) =>
						option.setName('value').setDescription('Value').setRequired(true),
					),
			},
			input: (source) => ({ value: source.interaction.options.getString('value', true) }),
			respond: ({ value }, source) => source.respond(value),
		})
	}
}
setParamToken(DiscordCommandOwnerTestPlugin, 0, DiscordPlugin)

describe('Discord client plugin', () => {
	it('splits a stored full API base into discord.js REST base and version', () => {
		expect(resolveDiscordRestOptions('https://discord.com/api/v10')).toEqual({
			api: 'https://discord.com/api',
			version: '10',
		})
		expect(resolveDiscordRestOptions('https://proxy.example/discord/api')).toEqual({
			api: 'https://proxy.example/discord/api',
			version: '10',
		})
	})

	it('uses the shared Bot extension and lifecycle surface while keeping helpers under $', async () => {
		const bot = new DiscordBot(
			{
				id: 'community',
				token: 'vault-secret',
				apiBase: 'https://discord.com/api/v10',
			},
			{
				commandGuildIds: [],
				readyTimeoutMs: 1_000,
				commandCatalog: () => ({ revision: 0, definitions: [] }),
				dispatchCommand: async () => false,
				matchesInteraction: () => false,
				dispatchInteraction: async () => false,
				onChanged: () => undefined,
				onError: () => undefined,
			},
		)

		expect(bot.$.info).toEqual({ id: 'community', apiBase: 'https://discord.com/api/v10' })
		expect(bot.$.status).toMatchObject({ phase: 'offline', botId: null, username: null })
		expect(Object.isFrozen(bot.$)).toBe(true)
		expect(Object.isFrozen(bot.$.status)).toBe(true)
		expect(Object.isFrozen(bot.$.status.gateway)).toBe(true)
		expect('sendChannelMessage' in bot).toBe(false)
		expect(() => bot.client).toThrow(/not ready/)
		await expect(bot.$.stop()).resolves.toMatchObject({ phase: 'offline' })
		bot.$.destroy()
		expect(bot.$.status.phase).toBe('destroyed')
		expect(() => bot.$.start()).toThrow(/destroyed/)
	})

	it('starts without configured bots and exposes health without Workbench', async () => {
		await withRuntimeHost(
			async (host) => {
				host.add(DiscordPlugin)
				host.cfg(DiscordPlugin).enable()
				await host.commit()

				expect([...host.require(DiscordPlugin).bots]).toEqual([])
				const response = await host.ctx.http.fetch(
					new Request('http://local.test/__pluxel/plugins/DiscordPlugin/api/health'),
				)
				expect(response.status).toBe(200)
				expect(await response.json()).toEqual({ ok: true, bots: [] })
			},
			{ workbench: false },
		)
	})

	it('shares interaction registration state through the injected caller view', async () => {
		await withRuntimeHost(
			async (host) => {
				host.add([DiscordPlugin, DiscordInteractionConsumerTestPlugin])
				host.cfg(DiscordPlugin).enable()
				host.cfg(DiscordInteractionConsumerTestPlugin).enable()
				await host.commit()

				const discord = host.require(DiscordPlugin)
				expect(() => discord.interactions.on('test:', () => undefined)).toThrow(
					/interaction prefix is already registered/,
				)

				host.remove(DiscordInteractionConsumerTestPlugin)
				await host.commit()
				const registration = discord.interactions.on('test:', () => undefined)
				registration.dispose()
			},
			{ workbench: false },
		)
	})

	it('merges slash projections and withdraws them with their owner', async () => {
		await withRuntimeHost(
			async (host) => {
				host.add([DiscordPlugin, DiscordCommandOwnerTestPlugin])
				host.cfg(DiscordPlugin).enable()
				host.cfg(DiscordCommandOwnerTestPlugin).enable()
				await host.commit()

				expect(host.require(DiscordPlugin).commands.list()).toMatchObject([
					{ name: 'test', options: [{ name: 'echo' }] },
				])

				host.remove(DiscordCommandOwnerTestPlugin)
				await host.commit()
				expect(host.require(DiscordPlugin).commands.list()).toEqual([])
			},
			{ workbench: false },
		)
	})
})
