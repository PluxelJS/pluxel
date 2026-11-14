import type { ProjectScript } from '@pluxel/host-vite/project'
import { Result } from '@pluxel/core/better-result'
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
	if (plugins.isErr()) return plugins
	const workspace = sdk.plugin(BotWorkspacePlugin)
	const status = await workspace.status()
	if (status.isErr()) return status
	const owner = status.value
	if (!owner) throw new Error('BotWorkspacePlugin is not registered')
	const instance = await workspace.instance()
	if (instance.isErr()) return instance
	const session = sdk.dev.ctx.require(WorkbenchHost).createSession(principal, () => {})
	try {
		using target = new RpcStub(session.target)
		const layout = await readWorkbenchLayout(target, { target: owner.address })
		return Result.ok({
			owner,
			providers: plugins.value.filter((plugin) =>
				['TelegramBotPlugin', 'DiscordBotPlugin', 'WeComBotPlugin'].includes(
					plugin.rootExportName ?? '',
				),
			),
			snapshot: instance.value.snapshot(),
			entries: layout.entries.map(({ descriptor, placement }) => ({
				key: descriptor.key,
				placement,
			})),
		})
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
	const workspace = sdk.plugin(BotWorkspacePlugin)
	const instance = await workspace.instance()
	if (instance.isErr()) return instance
	const identity = instance.value.identity(record.source, record.id)
	const status = await workspace.status()
	if (status.isErr()) return status
	const owner = status.value
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
	return Result.ok({ result, before, after })
}) satisfies ProjectScript

export const stopDiscord = (async (sdk) => {
	const { stop, status } = sdk.plugin(DiscordBotPlugin)
	const report = await stop()
	if (report.isErr()) return report
	const current = await status()
	if (current.isErr()) return current
	const workspace = await sdk.plugin(BotWorkspacePlugin).instance()
	if (workspace.isErr()) return workspace
	return Result.ok({
		report: report.value,
		current: current.value,
		snapshot: workspace.value.snapshot(),
	})
}) satisfies ProjectScript
export const startDiscord = (async (sdk) => {
	const { start, status } = sdk.plugin(DiscordBotPlugin)
	const report = await start()
	if (report.isErr()) return report
	const current = await status()
	if (current.isErr()) return current
	const workspace = await sdk.plugin(BotWorkspacePlugin).instance()
	if (workspace.isErr()) return workspace
	return Result.ok({
		report: report.value,
		current: current.value,
		snapshot: workspace.value.snapshot(),
	})
}) satisfies ProjectScript
