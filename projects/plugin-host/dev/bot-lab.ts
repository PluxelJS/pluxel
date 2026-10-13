import { defineDevConsole } from '@pluxel/host-vite/console'
import { openLocalWorkbenchEntry, WorkbenchHost } from '@pluxel/workbench/server'
import { consumeWorkbenchValue, readWorkbenchLayout } from '@pluxel/workbench/client'
import { RpcStub } from 'capnweb'
import { BotWorkspacePlugin } from '../src/bot-lab/BotWorkspacePlugin'
import { DiscordBotPlugin } from '../src/bot-lab/BotSources'
import { BotWorkspaceWorkbench } from '../src/bot-lab/BotWorkspace.workbench'

const principal = { provider: 'development-console', subject: 'bot-lab-validation' }

/** Read the real aggregator, provider lifecycles, and target-scoped publications. */
export default defineDevConsole(async (dev) => {
	const plugins = await dev.plugins.list()
	const owner = plugins.find((plugin) => plugin.rootExportName === 'BotWorkspacePlugin')
	if (!owner) throw new Error('BotWorkspacePlugin is not registered')
	const session = dev.ctx.require(WorkbenchHost).createSession(principal, () => {})
	try {
		using target = new RpcStub(session.target)
		const layout = await readWorkbenchLayout(target, { target: owner.address })
		return {
			owner,
			providers: plugins.filter((plugin) =>
				['TelegramBotPlugin', 'DiscordBotPlugin', 'WeComBotPlugin'].includes(
					plugin.rootExportName ?? '',
				),
			),
			snapshot: dev.plugins.require(BotWorkspacePlugin).snapshot(),
			entries: layout.entries.map(({ descriptor, placement }) => ({
				key: descriptor.key,
				placement,
			})),
		}
	} finally {
		session.dispose()
	}
})

/** Exercise the actual entity-scoped Workbench API, never a frontend-owned mock store. */
export const saveInstructions = defineDevConsole(async (dev) => {
	const input = dev.input
	if (!input || typeof input !== 'object' || Array.isArray(input))
		throw new TypeError('Expected source, id and instructions')
	const record = input as Record<string, unknown>
	if (typeof record.instructions !== 'string') throw new TypeError('Expected instructions string')
	const identity = dev.plugins.require(BotWorkspacePlugin).identity(record.source, record.id)
	const owner = (await dev.plugins.list()).find(
		(plugin) => plugin.rootExportName === 'BotWorkspacePlugin',
	)
	if (!owner) throw new Error('BotWorkspacePlugin is not registered')
	using opened = await openLocalWorkbenchEntry(dev.ctx, {
		target: owner.address,
		entry: BotWorkspaceWorkbench.bot,
		principal,
		location: `/bot-lab/${identity.source}/${identity.id}`,
		signal: dev.signal,
	})
	const before = await consumeWorkbenchValue(opened.api.snapshotDto(), 'Bot before save')
	const result = await consumeWorkbenchValue(
		opened.api.saveDto({ instructions: record.instructions, expectedRevision: before.revision }),
		'Bot save result',
	)
	const after = await consumeWorkbenchValue(opened.api.snapshotDto(), 'Bot after save')
	return { result, before, after }
})

export const stopDiscord = defineDevConsole(async (dev) => ({
	report: await dev.plugins.stop(DiscordBotPlugin),
	current: await dev.plugins.status(DiscordBotPlugin),
	snapshot: dev.plugins.require(BotWorkspacePlugin).snapshot(),
}))
export const startDiscord = defineDevConsole(async (dev) => ({
	report: await dev.plugins.start(DiscordBotPlugin),
	current: await dev.plugins.status(DiscordBotPlugin),
	snapshot: dev.plugins.require(BotWorkspacePlugin).snapshot(),
}))
