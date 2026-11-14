import type { ProjectScript } from '@pluxel/host-vite/project'
import { openLocalWorkbenchEntry, WorkbenchHost } from '@pluxel/workbench/server'
import { consumeWorkbenchValue, readWorkbenchLayout } from '@pluxel/workbench/client'
import { RpcStub } from 'capnweb'
import { BotWorkspacePlugin } from '../src/bot-lab/BotWorkspacePlugin'
import { DiscordBotPlugin } from '../src/bot-lab/BotSources'
import { BotWorkspaceWorkbench } from '../src/bot-lab/BotWorkspace.workbench'

const principal = { provider: 'development-console', subject: 'bot-lab-validation' }

/** Read the real aggregator, provider lifecycles, and target-scoped publications. */
export default (async (sdk) => {
	const plugins = await sdk.plugins.list()
	const owner = await sdk.plugin(sdk.dev.address(BotWorkspacePlugin)).status()
	if (!owner) throw new Error('BotWorkspacePlugin is not registered')
	const session = sdk.dev.ctx.require(WorkbenchHost).createSession(principal, () => {})
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
			snapshot: sdk.dev.instance(BotWorkspacePlugin).snapshot(),
			entries: layout.entries.map(({ descriptor, placement }) => ({
				key: descriptor.key,
				placement,
			})),
		}
	} finally {
		session.dispose()
	}
}) satisfies ProjectScript

/** Exercise the actual entity-scoped Workbench API, never a frontend-owned mock store. */
export const saveInstructions = (async (sdk, run) => {
	const input = run.input
	if (!input || typeof input !== 'object' || Array.isArray(input))
		throw new TypeError('Expected source, id and instructions')
	const record = input as Record<string, unknown>
	if (typeof record.instructions !== 'string') throw new TypeError('Expected instructions string')
	const identity = sdk.dev.instance(BotWorkspacePlugin).identity(record.source, record.id)
	const owner = await sdk.plugin(sdk.dev.address(BotWorkspacePlugin)).status()
	if (!owner) throw new Error('BotWorkspacePlugin is not registered')
	using opened = await openLocalWorkbenchEntry(sdk.dev.ctx, {
		target: owner.address,
		entry: BotWorkspaceWorkbench.bot,
		principal,
		location: `/bot-lab/${identity.source}/${identity.id}`,
		signal: run.signal,
	})
	const before = await consumeWorkbenchValue(opened.api.snapshotDto(), 'Bot before save')
	const result = await consumeWorkbenchValue(
		opened.api.saveDto({ instructions: record.instructions, expectedRevision: before.revision }),
		'Bot save result',
	)
	const after = await consumeWorkbenchValue(opened.api.snapshotDto(), 'Bot after save')
	return { result, before, after }
}) satisfies ProjectScript

export const stopDiscord = (async (sdk) => {
	const { stop, status } = sdk.plugin(sdk.dev.address(DiscordBotPlugin))
	return {
		report: await stop(),
		current: await status(),
		snapshot: sdk.dev.instance(BotWorkspacePlugin).snapshot(),
	}
}) satisfies ProjectScript
export const startDiscord = (async (sdk) => {
	const { start, status } = sdk.plugin(sdk.dev.address(DiscordBotPlugin))
	return {
		report: await start(),
		current: await status(),
		snapshot: sdk.dev.instance(BotWorkspacePlugin).snapshot(),
	}
}) satisfies ProjectScript
