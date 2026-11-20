import type { Script } from '@pluxel/agent-sdk/host'
import { openLocalWorkbenchEntry, WorkbenchHost } from '@pluxel/workbench/server'
import { consumeWorkbenchValue, readWorkbenchLayout } from '@pluxel/workbench/client'
import { RpcStub } from 'capnweb'
import { BotWorkspacePlugin } from '../src/bot-lab/BotWorkspacePlugin'
import { TelegramBotPlugin, DiscordBotPlugin, WeComBotPlugin } from '../src/bot-lab/BotSources'
import { BotWorkspaceWorkbench } from '../src/bot-lab/BotWorkspace.workbench'

const principal = { provider: 'development-console', subject: 'bot-lab-validation' }

/** Read the real aggregator, provider lifecycles, and target-scoped publications. */
export default (async (sdk) => {
	const providers = []
	for (const address of [
		TelegramBotPlugin.nodeAddress(),
		DiscordBotPlugin.nodeAddress(),
		WeComBotPlugin.nodeAddress(),
	]) {
		const provider = await sdk.plugin(address).status()
		if (provider) providers.push(provider)
	}
	const workspace = sdk.plugin(BotWorkspacePlugin.nodeAddress())
	const owner = await workspace.status()
	if (!owner) throw new Error('BotWorkspacePlugin is not registered')
	const { instance } = await workspace.instance()
	const session = sdk.ctx.service(WorkbenchHost).createSession(principal, () => {})
	try {
		using target = new RpcStub(session.target)
		const layout = await readWorkbenchLayout(target, { target: owner.address })
		return {
			owner,
			providers,
			snapshot: instance.snapshot(),
			entries: layout.entries.map(({ descriptor, placement }) => ({
				key: descriptor.key,
				placement,
			})),
		}
	} finally {
		session.dispose()
	}
}) satisfies Script

/** Exercise the actual entity-scoped Workbench API, never a frontend-owned mock store. */
export const saveInstructions = (async (sdk, run) => {
	const input = run.input
	if (!input || typeof input !== 'object' || Array.isArray(input))
		throw new TypeError('Expected source, id and instructions')
	const record = input as Record<string, unknown>
	if (typeof record.instructions !== 'string') throw new TypeError('Expected instructions string')
	const workspace = sdk.plugin(BotWorkspacePlugin.nodeAddress())
	const { instance } = await workspace.instance()
	const identity = instance.identity(record.source, record.id)
	const owner = await workspace.status()
	if (!owner) throw new Error('BotWorkspacePlugin is not registered')
	using opened = await openLocalWorkbenchEntry(sdk.ctx.service(WorkbenchHost), {
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
}) satisfies Script

export const stopDiscord = (async (sdk) => {
	const { stop, status } = sdk.plugin(DiscordBotPlugin.nodeAddress())
	const report = await stop()
	const current = await status()
	const { instance } = await sdk.plugin(BotWorkspacePlugin.nodeAddress()).instance()
	return { report, current, snapshot: instance.snapshot() }
}) satisfies Script
export const startDiscord = (async (sdk) => {
	const { start, status } = sdk.plugin(DiscordBotPlugin.nodeAddress())
	const report = await start()
	const current = await status()
	const { instance } = await sdk.plugin(BotWorkspacePlugin.nodeAddress()).instance()
	return { report, current, snapshot: instance.snapshot() }
}) satisfies Script
