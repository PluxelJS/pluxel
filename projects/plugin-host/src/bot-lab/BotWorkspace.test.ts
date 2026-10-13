import { standardServices } from '@pluxel/services'
import { createTestHost } from '@pluxel/test'
import { describe, expect, it, vi } from 'vitest'
import { BotWorkspacePlugin } from './BotWorkspacePlugin'
import { TelegramBotPlugin, DiscordBotPlugin, WeComBotPlugin } from './BotSources'
import { BotWorkspaceWorkbench } from './BotWorkspace.workbench'

const principal = { provider: 'test', subject: 'bot-lab' }
const plugins = [BotWorkspacePlugin, TelegramBotPlugin, DiscordBotPlugin, WeComBotPlugin] as const

async function start() {
	const host = await createTestHost({
		workbench: true,
		services: standardServices({ persistence: { mode: 'memory' } }),
	})
	try {
		await host.commit((change) => {
			change.catalog.add(plugins)
			change.start(TelegramBotPlugin)
			change.start(DiscordBotPlugin)
			change.start(WeComBotPlugin)
		})
		return host
	} catch (error) {
		await host.dispose()
		throw error
	}
}

describe('Bot workspace real plugin contributions', () => {
	it('aggregates three providers and isolates same-id bots through their bound Workbench RPC roots', async () => {
		await using host = await start()
		using list = await host.workbench.open({
			target: BotWorkspacePlugin,
			entry: BotWorkspaceWorkbench.list,
			principal,
		})
		using telegram = await host.workbench.open({
			target: BotWorkspacePlugin,
			entry: BotWorkspaceWorkbench.bot,
			location: '/bot-lab/telegram/support',
			principal,
		})
		using discord = await host.workbench.open({
			target: BotWorkspacePlugin,
			entry: BotWorkspaceWorkbench.bot,
			location: '/bot-lab/discord/support',
			principal,
		})
		const snapshot = await list.api.snapshotDto()
		expect(snapshot.sources).toHaveLength(3)
		expect(snapshot.bots).toHaveLength(6)
		expect(
			snapshot.bots.filter((bot) => bot.id === 'support' && bot.name === '客服助手'),
		).toHaveLength(3)
		const before = await telegram.api.snapshotDto()
		const other = await discord.api.snapshotDto()
		await expect(
			telegram.api.saveDto({ instructions: 'Telegram only', expectedRevision: before.revision }),
		).resolves.toEqual({ ok: true })
		await expect(telegram.api.snapshotDto()).resolves.toMatchObject({
			instructions: 'Telegram only',
		})
		await expect(discord.api.snapshotDto()).resolves.toEqual(other)
		await expect(
			telegram.api.saveDto({ instructions: 'stale overwrite', expectedRevision: before.revision }),
		).resolves.toMatchObject({ ok: false, code: 'conflict' })
		const current = await telegram.api.snapshotDto()
		await expect(
			telegram.api.saveDto({ instructions: '', expectedRevision: current.revision }),
		).resolves.toMatchObject({ ok: false, code: 'invalid_input' })
		await expect(
			telegram.api.setRunningDto({ running: false, expectedRevision: current.revision }),
		).resolves.toEqual({ ok: true })
		await expect(telegram.api.snapshotDto()).resolves.toMatchObject({ running: false })
		await expect(discord.api.snapshotDto()).resolves.toMatchObject({ running: true })
	})

	it('withdraws only the stopped provider, retains unavailable last-known bots, and rejects pre-restart revisions', async () => {
		await using host = await start()
		using list = await host.workbench.open({
			target: BotWorkspacePlugin,
			entry: BotWorkspaceWorkbench.list,
			principal,
		})
		using telegram = await host.workbench.open({
			target: BotWorkspacePlugin,
			entry: BotWorkspaceWorkbench.bot,
			location: '/bot-lab/telegram/support',
			principal,
		})
		using discord = await host.workbench.open({
			target: BotWorkspacePlugin,
			entry: BotWorkspaceWorkbench.bot,
			location: '/bot-lab/discord/support',
			principal,
		})
		const aggregator = host.require(BotWorkspacePlugin)
		const old = await telegram.api.snapshotDto()
		const changed = vi.fn()
		using _subscription = await list.api.watch(changed)
		await host.stop(TelegramBotPlugin)
		await vi.waitFor(() => expect(changed).toHaveBeenCalled())
		expect(host.isRunning(BotWorkspacePlugin)).toBe(true)
		expect(host.require(BotWorkspacePlugin)).toBe(aggregator)
		expect(host.isRunning(DiscordBotPlugin)).toBe(true)
		await expect(telegram.api.snapshotDto()).resolves.toMatchObject({
			available: false,
			name: old.name,
			instructions: old.instructions,
		})
		await expect(
			telegram.api.saveDto({ instructions: 'blocked', expectedRevision: old.revision }),
		).resolves.toMatchObject({ ok: false, code: 'unavailable' })
		const available = await discord.api.snapshotDto()
		await expect(
			discord.api.saveDto({
				instructions: 'Discord remains live',
				expectedRevision: available.revision,
			}),
		).resolves.toEqual({ ok: true })
		await host.start(TelegramBotPlugin)
		await expect(telegram.api.snapshotDto()).resolves.toMatchObject({ available: true })
		await expect(
			telegram.api.saveDto({
				instructions: 'old draft after restart',
				expectedRevision: old.revision,
			}),
		).resolves.toMatchObject({ ok: false, code: 'conflict' })
		const restored = await list.api.snapshotDto()
		expect(restored.bots).toHaveLength(6)
	})

	it('releases per-open view watches and Content subscriptions without closing sibling roots', async () => {
		await using host = await start()
		const workspace = host.require(BotWorkspacePlugin)
		const subscribe = workspace.subscribe.bind(workspace)
		const released = vi.fn()
		const spy = vi.spyOn(workspace, 'subscribe').mockImplementation((listener) => {
			const subscription = subscribe(listener)
			let done = false
			return {
				[Symbol.dispose]: () => {
					if (done) return
					done = true
					released()
					subscription[Symbol.dispose]()
				},
			}
		})
		using list = await host.workbench.open({
			target: BotWorkspacePlugin,
			entry: BotWorkspaceWorkbench.list,
			principal,
		})
		using sibling = await host.workbench.open({
			target: BotWorkspacePlugin,
			entry: BotWorkspaceWorkbench.list,
			principal,
		})
		using sources = await host.workbench.open({
			target: BotWorkspacePlugin,
			entry: BotWorkspaceWorkbench.sources,
			principal,
		})
		using events = await host.workbench.open({
			target: BotWorkspacePlugin,
			entry: BotWorkspaceWorkbench.events,
			principal,
		})
		const firstChanged = vi.fn()
		const siblingChanged = vi.fn()
		using _first = await list.api.watch(firstChanged)
		using second = await sibling.api.watch(siblingChanged)
		const content = await sources.root.subscribeDto(() => undefined)
		expect(content).toMatchObject({
			ok: true,
			data: { sources: expect.arrayContaining([{ label: 'Telegram', available: true, count: 2 }]) },
		})
		await expect(events.root.subscribeDto(() => undefined)).resolves.toMatchObject({
			ok: true,
			data: { events: expect.any(Array) },
		})
		list[Symbol.dispose]()
		sources[Symbol.dispose]()
		events[Symbol.dispose]()
		expect(released).toHaveBeenCalledTimes(3)
		await host.stop(WeComBotPlugin)
		await vi.waitFor(() => expect(siblingChanged).toHaveBeenCalledTimes(1))
		expect(firstChanged).not.toHaveBeenCalled()
		second[Symbol.dispose]()
		expect(released).toHaveBeenCalledTimes(4)
		spy.mockRestore()
	})
})
