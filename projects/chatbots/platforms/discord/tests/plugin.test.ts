import { BasePlugin, Plugin, setParamToken, withRuntimeHost } from '@pluxel/runtime/test'
import { defineCommand } from '@pluxel/commands'
import { Type, obj } from '@pluxel/commands/typebox'
import { describe, expect, it } from 'vitest'
import { DiscordPlugin } from '../src/plugin.ts'

@Plugin({ name: 'DiscordInteractionConsumerTestPlugin' })
class DiscordInteractionConsumerTestPlugin extends BasePlugin {
	constructor(private readonly discord: DiscordPlugin) {
		super()
	}

	override init(): void {
		this.ctx.effects.defer(this.discord.registerInteractionConsumer('test:', () => undefined))
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
	it('starts without configured bots and exposes health without Workbench', async () => {
		await withRuntimeHost(
			async (host) => {
				host.add(DiscordPlugin)
				host.cfg(DiscordPlugin).enable()
				await host.commit()

				expect(host.require(DiscordPlugin).bots.list()).toEqual([])
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
				expect(() => discord.registerInteractionConsumer('test:', () => undefined)).toThrow(
					/interaction prefix is already registered/,
				)

				host.remove(DiscordInteractionConsumerTestPlugin)
				await host.commit()
				const unregister = discord.registerInteractionConsumer('test:', () => undefined)
				unregister()
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
